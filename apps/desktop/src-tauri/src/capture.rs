use std::time::SystemTime;

use image::{codecs::jpeg::JpegEncoder, ColorType, Rgba, RgbaImage};
use serde::Serialize;
use xcap::Monitor;

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

/// Captures all attached monitors. When multiple monitors are present we
/// stitch them side-by-side into a single wide image so each capture event
/// produces ONE screenshot (one row, one thumbnail) covering the whole
/// workspace. Single-monitor setups produce a single image unchanged.
///
/// Failures on an individual monitor are logged and skipped; if at least one
/// monitor was captured we proceed with what we have. If every monitor fails
/// the function errors.
pub fn capture_all() -> Result<Vec<CapturedScreenshot>, CaptureError> {
    let monitors = Monitor::all().map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;
    if monitors.is_empty() {
        return Err(CaptureError::NoDisplays);
    }

    let captured_at_ms = now_ms();
    let mut images: Vec<RgbaImage> = Vec::with_capacity(monitors.len());
    for (idx, monitor) in monitors.iter().enumerate() {
        match monitor.capture_image() {
            Ok(img) => images.push(img),
            Err(e) => {
                tracing::warn!(monitor = idx, err = %e, "monitor capture failed; skipping");
            }
        }
    }

    if images.is_empty() {
        return Err(CaptureError::CaptureFailed(
            "all monitor captures failed".into(),
        ));
    }

    // Single monitor: encode as-is (no stitching overhead).
    if images.len() == 1 {
        let img = images.into_iter().next().expect("len checked above");
        return Ok(vec![encode_one(img, 0, captured_at_ms)?]);
    }

    // Multi-monitor: lay out left-to-right in capture order. Heights are
    // unified by padding shorter monitors with black at the bottom so none of
    // the images are scaled or distorted.
    let stitched = stitch_horizontally(&images);
    Ok(vec![encode_one(stitched, 0, captured_at_ms)?])
}

/// Composes `images` into a single RgbaImage placed side-by-side. The output
/// height is `max(image.height())`; any image shorter than that is left at
/// its original height and the unused area below is black (alpha 255).
fn stitch_horizontally(images: &[RgbaImage]) -> RgbaImage {
    let total_width: u32 = images.iter().map(|i| i.width()).sum();
    let max_height: u32 = images.iter().map(|i| i.height()).max().unwrap_or(0);

    // Start with an opaque black canvas so missing strips read as black bars
    // rather than transparent (JPEG drops alpha anyway, so transparent would
    // become white).
    let mut canvas = RgbaImage::from_pixel(total_width, max_height, Rgba([0, 0, 0, 255]));

    let mut x_offset: u32 = 0;
    for img in images {
        for y in 0..img.height() {
            for x in 0..img.width() {
                let p = *img.get_pixel(x, y);
                canvas.put_pixel(x_offset + x, y, p);
            }
        }
        x_offset += img.width();
    }
    canvas
}

