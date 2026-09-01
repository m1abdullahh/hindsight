//! Silent screen capture on Wayland, via the XDG ScreenCast portal.
//!
//! ## Why not the Screenshot portal
//!
//! `xcap`'s Wayland path calls `org.freedesktop.portal.Screenshot`. GNOME shows
//! a "Share this screenshot with the requesting application?" dialog for *every*
//! such call, and the flag `xcap` passes (`interactive: false`) only suppresses
//! the area-picker UI — not the consent step. That consent can never be
//! remembered either: the portal permission store has tables for `notifications`
//! and `screencast`, but none for screenshots. A tracker capturing once a minute
//! would therefore raise a dialog once a minute, forever.
//!
//! ## What this does instead
//!
//! ScreenCast is the portal designed for continuous capture. Selecting sources
//! with `persist_mode = ExplicitlyRevoked` makes the portal return a
//! `restore_token`; handing that token back on the next run restores the same
//! monitor selection with no dialog at all. Measured on
//! xdg-desktop-portal-gnome 42.1: 9.5s with the prompt on first run, then 0.01s
//! and silent on every run afterwards, across process restarts.
//!
//! The session and its PipeWire streams are opened once and kept alive for the
//! lifetime of the process. Streams sit inactive between captures and are woken
//! only long enough to pull one frame, so an idle tracker costs nothing.

use std::{
    io::Cursor,
    os::fd::OwnedFd,
    path::PathBuf,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SourceType},
    PersistMode,
};
use image::RgbaImage;
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use pipewire::{
    channel as pw_channel,
    context::Context,
    keys::{MEDIA_CATEGORY, MEDIA_ROLE, MEDIA_TYPE},
    main_loop::MainLoop,
    properties,
    spa::{
        param::{
            format::{FormatProperties, MediaSubtype, MediaType},
            format_utils,
            video::{VideoFormat, VideoInfoRaw},
            ParamType,
        },
        pod::{self, serialize::PodSerializer, Pod},
        utils::{Direction, Fraction, Rectangle, SpaTypes},
    },
    stream::{Stream, StreamFlags},
};

/// How long to wait for the portal to answer. The first run needs a human to
/// click "Share", hence the generous window; restored sessions return in
/// milliseconds.
const PORTAL_TIMEOUT: Duration = Duration::from_secs(120);

/// How long to wait for every stream to deliver a frame once woken.
const FRAME_TIMEOUT: Duration = Duration::from_secs(15);

static CAPTURER: OnceCell<Mutex<Option<Capturer>>> = OnceCell::new();
static TOKEN_PATH: OnceCell<PathBuf> = OnceCell::new();

/// Where to persist the portal's `restore_token`. Set once at startup from the
/// Tauri app-data dir; falls back to the XDG data dir if never called.
pub fn set_token_path(path: PathBuf) {
    let _ = TOKEN_PATH.set(path);
}

fn token_path() -> PathBuf {
    TOKEN_PATH.get().cloned().unwrap_or_else(|| {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(std::env::temp_dir);
        base.join("hindsight").join("screencast_token")
    })
}

fn load_token() -> Option<String> {
    let raw = std::fs::read_to_string(token_path()).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn save_token(token: &str) {
    let path = token_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, token) {
        tracing::warn!(err = %e, path = %path.display(), "could not persist screencast restore token");
    }
}

/// True when the process is running under a Wayland compositor. Mirrors
/// `xcap`'s own detection so the two agree on which backend owns the capture.
pub fn is_wayland() -> bool {
    let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    let wayland_display = std::env::var("WAYLAND_DISPLAY").unwrap_or_default();
    session_type == "wayland" || wayland_display.to_lowercase().contains("wayland")
}

struct Frame {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

struct Capturer {
    frames: Arc<Mutex<Vec<Option<Frame>>>>,
    activate: pw_channel::Sender<bool>,
}

/// Captures one frame per selected monitor, in the order the portal returned
/// them. Negotiates the portal session on first call and reuses it afterwards.
pub fn capture_monitors() -> Result<Vec<RgbaImage>, String> {
    let cell = CAPTURER.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock();

    if guard.is_none() {
        *guard = Some(Capturer::start()?);
    }

    let result = guard
        .as_ref()
        .expect("just populated")
        .grab();

    // A failed grab usually means the session died (monitor unplugged, portal
    // restarted, user revoked). Drop it so the next capture renegotiates —
    // silently, because the restore token is on disk.
    if result.is_err() {
        *guard = None;
    }
    result
}

impl Capturer {
    fn start() -> Result<Self, String> {
        let (node_ids, fd) = negotiate_portal()?;
        if node_ids.is_empty() {
            return Err("portal returned no streams".into());
        }

        let frames: Arc<Mutex<Vec<Option<Frame>>>> =
            Arc::new(Mutex::new((0..node_ids.len()).map(|_| None).collect()));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (activate, activate_rx) = pw_channel::channel::<bool>();

        let frames_for_thread = frames.clone();
        let ready_for_thread = ready_tx.clone();
        thread::Builder::new()
            .name("hindsight-pipewire".into())
            .spawn(move || {
                if let Err(e) =
                    run_pipewire(fd, node_ids, frames_for_thread, activate_rx, ready_tx)
                {
                    let _ = ready_for_thread.send(Err(e));
                }
            })
            .map_err(|e| format!("could not spawn pipewire thread: {e}"))?;

        ready_rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "timed out waiting for pipewire streams".to_string())??;

        Ok(Self { frames, activate })
    }

    fn grab(&self) -> Result<Vec<RgbaImage>, String> {
        let count = self.frames.lock().len();

        // Discard anything stale so we can't hand back the previous capture.
        {
            let mut slots = self.frames.lock();
            for slot in slots.iter_mut() {
                *slot = None;
            }
        }

        self.activate
            .send(true)
            .map_err(|_| "pipewire loop is gone".to_string())?;

        let deadline = Instant::now() + FRAME_TIMEOUT;
        let filled = loop {
            if self.frames.lock().iter().all(|f| f.is_some()) {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            thread::sleep(Duration::from_millis(25));
        };

        // Park the streams again regardless of outcome; an active screencast
        // keeps the compositor encoding frames we would only throw away.
        let _ = self.activate.send(false);

        if !filled {
            return Err(format!(
                "only {} of {count} stream(s) delivered a frame within {}s",
                self.frames.lock().iter().filter(|f| f.is_some()).count(),
                FRAME_TIMEOUT.as_secs()
            ));
        }

        let mut slots = self.frames.lock();
        let mut images = Vec::with_capacity(slots.len());
        for slot in slots.iter_mut() {
            let Some(frame) = slot.take() else { continue };
            let image = RgbaImage::from_raw(frame.width, frame.height, frame.rgba)
                .ok_or_else(|| "frame buffer did not match its dimensions".to_string())?;
            images.push(image);
        }
        Ok(images)
    }
}

/// Runs the ScreenCast handshake and hands back the PipeWire node ids plus a
/// remote fd. The portal session must outlive the streams, so the negotiating
/// thread parks forever instead of returning — dropping the zbus connection
/// would close the session and kill every stream with it.
fn negotiate_portal() -> Result<(Vec<u32>, OwnedFd), String> {
    let (tx, rx) = mpsc::channel::<Result<(Vec<u32>, OwnedFd), String>>();

    thread::Builder::new()
        .name("hindsight-screencast".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = tx.send(Err(format!("could not build portal runtime: {e}")));
                    return;
                }
            };

            runtime.block_on(async move {
                let outcome = negotiate().await;
                let ok = outcome.is_ok();
                let _ = tx.send(outcome);
                if ok {
                    // Hold the session (and its D-Bus connection) open for the
                    // lifetime of the process.
                    std::future::pending::<()>().await;
                }
            });
        })
        .map_err(|e| format!("could not spawn portal thread: {e}"))?;

    rx.recv_timeout(PORTAL_TIMEOUT)
        .map_err(|_| "screen-share request timed out (no response from the portal)".to_string())?
}

async fn negotiate() -> Result<(Vec<u32>, OwnedFd), String> {
    let proxy = Screencast::new()
        .await
        .map_err(|e| format!("screencast portal unavailable: {e}"))?;
    let session = proxy
        .create_session()
        .await
        .map_err(|e| format!("could not create screencast session: {e}"))?;

    let stored = load_token();
    let restoring = stored.is_some();

    proxy
        .select_sources(
            &session,
            CursorMode::Embedded,
            SourceType::Monitor.into(),
            true, // allow picking every monitor in one go
            stored.as_deref(),
            PersistMode::ExplicitlyRevoked,
        )
        .await
        .map_err(|e| format!("could not select screencast sources: {e}"))?
        .response()
        .map_err(|e| format!("source selection was rejected: {e}"))?;

    let streams = proxy
        .start(&session, None)
        .await
        .map_err(|e| format!("could not start screencast: {e}"))?
        .response()
        .map_err(|e| format!("screen sharing was denied: {e}"))?;

    match streams.restore_token() {
        Some(token) => save_token(token),
        // Without a token every launch would prompt again; worth flagging.
        None if !restoring => {
            tracing::warn!("portal returned no restore token; captures will prompt again next run")
        }
        None => {}
    }

    let node_ids: Vec<u32> = streams
        .streams()
        .iter()
        .map(|s| s.pipe_wire_node_id())
        .collect();

    let fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .map_err(|e| format!("could not open pipewire remote: {e}"))?;

    tracing::info!(
        streams = node_ids.len(),
        restored = restoring,
        "screencast session ready"
    );
    Ok((node_ids, fd))
}

#[derive(Clone, Default)]
struct StreamUserData {
    format: VideoInfoRaw,
}

fn run_pipewire(
    fd: OwnedFd,
    node_ids: Vec<u32>,
    frames: Arc<Mutex<Vec<Option<Frame>>>>,
    activate_rx: pw_channel::Receiver<bool>,
    ready: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    pipewire::init();

    let main_loop = MainLoop::new(None).map_err(|e| format!("pipewire main loop: {e}"))?;
    let context = Context::new(&main_loop).map_err(|e| format!("pipewire context: {e}"))?;
    let core = context
        .connect_fd(fd, None)
        .map_err(|e| format!("pipewire connect: {e}"))?;

    let mut built = Vec::with_capacity(node_ids.len());
    for _ in &node_ids {
        built.push(
            Stream::new(
                &core,
                "Hindsight",
                properties::properties! {
                    *MEDIA_TYPE => "Video",
                    *MEDIA_CATEGORY => "Capture",
                    *MEDIA_ROLE => "Screen",
                },
            )
            .map_err(|e| format!("pipewire stream: {e}"))?,
        );
    }

    // The loop below never returns, so the streams genuinely do live for the
    // rest of the process. Leaking them yields the `'static` borrows that both
    // the listeners and the activate callback need to hold at once.
    let streams: &'static [Stream] = Box::leak(built.into_boxed_slice());

    let mut listeners = Vec::with_capacity(streams.len());
    for (index, stream) in streams.iter().enumerate() {
        let frames = frames.clone();
        let listener = stream
            .add_local_listener_with_user_data(StreamUserData::default())
            .state_changed(move |_, _, old, new| {
                tracing::debug!(?old, ?new, "screencast stream state");
            })
            .param_changed(|_, user_data, id, param| {
                let Some(param) = param else { return };
                if id != ParamType::Format.as_raw() {
                    return;
                }
                match format_utils::parse_format(param) {
                    Ok((MediaType::Video, MediaSubtype::Raw)) => {}
                    Ok(_) => return,
                    Err(e) => {
                        tracing::warn!(err = ?e, "could not parse stream format");
                        return;
                    }
                }
                if let Err(e) = user_data.format.parse(param) {
                    tracing::warn!(err = ?e, "could not read video format");
                }
            })
            .process(move |stream, user_data| {
                let Some(mut buffer) = stream.dequeue_buffer() else {
                    return;
                };
                let datas = buffer.datas_mut();
                if datas.is_empty() {
                    return;
                }

                let size = user_data.format.size();
                let (width, height) = (size.width, size.height);
                if width == 0 || height == 0 {
                    return;
                }

                let format = user_data.format.format();
                let stride = datas[0].chunk().stride().max(0) as usize;
                let Some(src) = datas[0].data() else { return };
                let Some(rgba) = to_rgba(src, width, height, stride, format) else {
                    return;
                };

                if let Some(slot) = frames.lock().get_mut(index) {
                    *slot = Some(Frame {
                        width,
                        height,
                        rgba,
                    });
                }
            })
            .register()
            .map_err(|e| format!("pipewire listener: {e}"))?;
        listeners.push(listener);
    }

    for (index, stream) in streams.iter().enumerate() {
        let values = format_params()?;
        let mut params = [Pod::from_bytes(&values)
            .ok_or_else(|| "could not build format pod".to_string())?];
        // INACTIVE: sit idle until a capture asks for a frame.
        stream
            .connect(
                Direction::Input,
                Some(node_ids[index]),
                StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::INACTIVE,
                &mut params,
            )
            .map_err(|e| format!("pipewire stream connect: {e}"))?;
    }

    ready
        .send(Ok(()))
        .map_err(|_| "capture caller went away".to_string())?;

    let _attached = activate_rx.attach(main_loop.loop_(), move |active| {
        for stream in streams.iter() {
            if let Err(e) = stream.set_active(active) {
                tracing::warn!(err = ?e, active, "could not toggle stream");
            }
        }
    });

    main_loop.run();
    Ok(())
}

/// The formats we accept, in the order PipeWire should prefer them. GNOME
/// hands out BGRx in practice; the rest are cheap to support.
fn format_params() -> Result<Vec<u8>, String> {
    let obj = pod::object!(
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pod::property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::RGB,
            VideoFormat::RGBA,
            VideoFormat::RGBx,
            VideoFormat::BGRx,
        ),
        // The upper bound must stay within what the compositor will offer to
        // negotiate against; 16384 made Mutter bail with "no more input
        // formats", while 8192 comfortably covers an 8K-wide monitor.
        pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle {
                width: 128,
                height: 128
            },
            Rectangle {
                width: 1,
                height: 1
            },
            Rectangle {
                width: 8192,
                height: 8192
            }
        ),
        // The range must cover whatever fixed rate the compositor's node
        // advertises (Mutter offers the panel's refresh rate — capping below
        // it fails negotiation with "no more input formats"). The rate barely
        // matters anyway: streams are only active for the moment it takes to
        // pull one frame.
        pod::property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: 24, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction {
                num: 1000,
                denom: 1
            }
        ),
    );

    let values = PodSerializer::serialize(Cursor::new(Vec::new()), &pod::Value::Object(obj))
        .map_err(|e| format!("could not serialize format: {e}"))?
        .0
        .into_inner();
    Ok(values)
}

/// Converts one PipeWire frame into tightly packed RGBA.
///
/// `stride` is the source's bytes-per-row, which is padded to the compositor's
/// alignment and is usually wider than `width * 4`. Copying the buffer straight
/// through (as `xcap` does) skews the image on any monitor whose width isn't
/// already aligned, so each row is copied individually.
fn to_rgba(
    src: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    format: VideoFormat,
) -> Option<Vec<u8>> {
    let (width, height) = (width as usize, height as usize);
    let src_bpp = match format {
        VideoFormat::RGB => 3,
        VideoFormat::BGRx | VideoFormat::RGBx | VideoFormat::RGBA | VideoFormat::BGRA => 4,
        other => {
            tracing::warn!(format = ?other, "unsupported pixel format from compositor");
            return None;
        }
    };

    let row_bytes = width * src_bpp;
    let stride = if stride >= row_bytes { stride } else { row_bytes };
    if src.len() < stride * (height - 1) + row_bytes {
        tracing::warn!(
            len = src.len(),
            stride,
            width,
            height,
            "frame buffer shorter than its declared geometry"
        );
        return None;
    }

    let swap_rb = matches!(format, VideoFormat::BGRx | VideoFormat::BGRA);
    let mut out = vec![0u8; width * height * 4];

    for y in 0..height {
        let row = &src[y * stride..y * stride + row_bytes];
        let dst = &mut out[y * width * 4..(y + 1) * width * 4];
        for (pixel, chunk) in row.chunks_exact(src_bpp).zip(dst.chunks_exact_mut(4)) {
            if swap_rb {
                chunk[0] = pixel[2];
                chunk[1] = pixel[1];
                chunk[2] = pixel[0];
            } else {
                chunk[0] = pixel[0];
                chunk[1] = pixel[1];
                chunk[2] = pixel[2];
            }
            // Compositor alpha is meaningless for a screenshot (and zero in the
            // `x` formats), and JPEG drops it anyway — force opaque.
            chunk[3] = 255;
        }
    }

    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_bgrx_and_swaps_channels() {
        // 2x1 pixels, BGRx: blue-ish then red-ish.
        let src = vec![10, 20, 30, 0, 40, 50, 60, 0];
        let out = to_rgba(&src, 2, 1, 8, VideoFormat::BGRx).expect("converts");
        assert_eq!(out, vec![30, 20, 10, 255, 60, 50, 40, 255]);
    }

    #[test]
    fn honours_row_padding() {
        // 1x2 pixels with a stride of 8 bytes: 4 bytes of pixel + 4 of padding.
        let src = vec![1, 2, 3, 0, 9, 9, 9, 9, 4, 5, 6, 0, 9, 9, 9, 9];
        let out = to_rgba(&src, 1, 2, 8, VideoFormat::RGBx).expect("converts");
        assert_eq!(out, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn rejects_a_truncated_buffer() {
        let src = vec![0u8; 4];
        assert!(to_rgba(&src, 4, 4, 16, VideoFormat::BGRx).is_none());
    }

    #[test]
    fn rejects_unsupported_formats() {
        let src = vec![0u8; 64];
        assert!(to_rgba(&src, 2, 2, 8, VideoFormat::YUY2).is_none());
    }
}
