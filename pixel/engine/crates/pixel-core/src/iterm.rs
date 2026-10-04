use std::io;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use image::ImageEncoder as _;

pub(crate) fn transmit(width: u32, height: u32, rgba: &[u8]) -> io::Result<Vec<u8>> {
    if rgba.len() != (width * height * 4) as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "RGBA data does not match the image dimensions",
        ));
    }

    let mut png = Vec::new();
    crate::profiler::span("iterm.png", || {
        image::codecs::png::PngEncoder::new_with_quality(
            &mut png,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        )
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
    })
    .map_err(io::Error::other)?;
    let payload = crate::profiler::span("iterm.base64", || BASE64.encode(png));
    let header = format!(
        "\x1b]1337;File=inline=1;width={width}px;height={height}px;preserveAspectRatio=0;doNotMoveCursor=1:"
    );
    let mut out = Vec::with_capacity(header.len() + payload.len() + 1);
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(payload.as_bytes());
    out.push(0x07);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transmits_a_png_without_moving_the_cursor() {
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255];
        let out = transmit(2, 1, &rgba).unwrap();
        let header = b"\x1b]1337;File=inline=1;width=2px;height=1px;preserveAspectRatio=0;doNotMoveCursor=1:";
        assert!(out.starts_with(header));
        assert_eq!(out.last(), Some(&0x07));
        let png = BASE64
            .decode(&out[header.len()..out.len() - 1])
            .unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let image = image::load_from_memory(&png).unwrap().into_rgba8();
        assert_eq!(image.dimensions(), (2, 1));
        assert_eq!(image.as_raw(), &rgba);
    }

    #[test]
    fn rejects_mismatched_pixel_data() {
        let err = transmit(2, 1, &[0; 4]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }
}
