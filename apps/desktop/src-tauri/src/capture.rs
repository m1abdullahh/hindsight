use std::time::SystemTime;

use image::{codecs::jpeg::JpegEncoder, ColorType};
// Use the RgbaImage from screenshots' re-export so the type matches what
// `screen.capture()` returns — our direct `image` dep is a different major
// version than screenshots' internal one.
use screenshots::image::RgbaImage;
use screenshots::Screen;
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct CapturedScreenshot {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub captured_at_ms: i64,
    pub monitor_index: u32,
}

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CaptureError {
    #[error("no displays available")]
    NoDisplays,
    #[error("capture failed: {0}")]
    CaptureFailed(String),
    #[error("encode failed: {0}")]
    EncodeFailed(String),
}

const JPEG_QUALITY: u8 = 75;

fn encode_one(
    image: RgbaImage,
    monitor_index: u32,
    captured_at_ms: i64,
) -> Result<CapturedScreenshot, CaptureError> {
    let width = image.width();
    let height = image.height();
    let rgba = image.into_raw();

    // JPEG has no alpha channel — drop it. Each pixel is 4 bytes (R,G,B,A);
    // we keep the first three.
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for chunk in rgba.chunks_exact(4) {
        rgb.push(chunk[0]);
        rgb.push(chunk[1]);
        rgb.push(chunk[2]);
    }

    let mut buf = Vec::with_capacity((width * height) as usize);
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
        encoder
            .encode(&rgb, width, height, ColorType::Rgb8.into())
            .map_err(|e| CaptureError::EncodeFailed(e.to_string()))?;
    }

    Ok(CapturedScreenshot {
        bytes: buf,
        width,
        height,
        captured_at_ms,
        monitor_index,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Captures all attached monitors. Returns one `CapturedScreenshot` per monitor
/// in index order. If a particular monitor fails (e.g. permission denied on a
/// secondary display), it's logged and skipped — we don't fail the whole capture
/// event. Returns an empty Vec if there are no displays at all.
pub fn capture_all() -> Result<Vec<CapturedScreenshot>, CaptureError> {
    let screens = Screen::all().map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;
    if screens.is_empty() {
        return Err(CaptureError::NoDisplays);
    }

    let captured_at_ms = now_ms();
    let mut out = Vec::with_capacity(screens.len());
    for (idx, screen) in screens.iter().enumerate() {
        let image = match screen.capture() {
            Ok(img) => img,
            Err(e) => {
                tracing::warn!(monitor = idx, err = %e, "monitor capture failed; skipping");
                continue;
            }
        };
        match encode_one(image, idx as u32, captured_at_ms) {
            Ok(shot) => out.push(shot),
            Err(e) => tracing::warn!(monitor = idx, err = %e, "monitor encode failed; skipping"),
        }
    }

    if out.is_empty() {
        return Err(CaptureError::CaptureFailed(
            "all monitor captures failed".into(),
        ));
    }
    Ok(out)
}

