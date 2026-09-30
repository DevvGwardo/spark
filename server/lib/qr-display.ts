import * as QRCode from 'qrcode';

/**
 * Generate a terminal QR code string for an URL.
 */
export async function generateTerminalQr(url: string): Promise<string> {
  try {
    return await QRCode.toString(url, {
      type: 'terminal',
      small: true,
    });
  } catch {
    return '[QR code generation failed]';
  }
}

/**
 * Generate an SVG data URI for an URL (embeddable in <img> or background-image).
 */
export async function generateQrSvgDataUri(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#00000000', // transparent
    },
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
