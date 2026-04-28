# Image Format Converter

Convert images between common formats (JPEG, PNG, GIF, WebP, BMP, TIFF) using ImageMagick.

## Requirements

- ImageMagick 7 (`magick` command) or ImageMagick 6 (`convert` command) must be installed and available in PATH.

## Usage

1. Select the input image file.
2. Choose the desired output format.
3. Optionally set quality (for JPEG and WebP).
4. Specify where to save the converted image (save dialog will appear before conversion).
5. The script will convert the image and show a preview.

The script automatically detects either `magick` or `convert` command.