/**
 * Gemini Media Analysis — host-side media processing for nanoflash.
 * Runs on the host (not inside the container).
 *
 * NOTE: Direct API key usage is intentional here — this runs on the host
 * process which already reads .env. No container or subprocess is involved.
 */
import { GoogleGenAI } from '@google/genai';
import {
  GEMINI_API_KEY,
  GEMINI_FAST_MODEL,
  GEMINI_MAX_VIDEO_MB,
} from './config.js';
import { logger } from './logger.js';

const WEB_FETCH_MAX_BYTES = 50 * 1024; // 50 KB

function getClient(): GoogleGenAI {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

/**
 * Analyse an image using Gemini Flash. Returns a text description.
 * @param buffer   Raw image bytes
 * @param mimeType MIME type (e.g. 'image/jpeg'). Defaults to 'image/jpeg'.
 * @param caption  Optional caption or question from the sender
 */
export async function analyzeImage(
  buffer: Buffer,
  mimeType?: string,
  caption?: string,
): Promise<string> {
  try {
    const ai = getClient();

    const prompt = caption
      ? `The user sent this image with the message: "${caption}"\n\nDescribe the image and address the user's message.`
      : 'Describe this image in detail.';

    const response = await ai.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents: [
        {
          inlineData: {
            mimeType: mimeType || 'image/jpeg',
            data: buffer.toString('base64'),
          },
        },
        prompt,
      ],
    });

    return response.text ?? '';
  } catch (err) {
    logger.error({ err }, 'analyzeImage failed');
    throw err;
  }
}

/**
 * Analyse a video using Gemini Flash. Returns a text description.
 * Enforces a size cap (default 20 MB, configurable via GEMINI_MAX_VIDEO_MB).
 * @param buffer   Raw video bytes
 * @param mimeType MIME type (e.g. 'video/mp4')
 * @param caption  Optional caption from the sender
 */
export async function analyzeVideo(
  buffer: Buffer,
  mimeType: string,
  caption?: string,
): Promise<string> {
  const maxBytes = GEMINI_MAX_VIDEO_MB * 1024 * 1024;
  if (buffer.length > maxBytes) {
    return `[Video too large to analyse — ${(buffer.length / 1024 / 1024).toFixed(1)} MB exceeds ${GEMINI_MAX_VIDEO_MB} MB limit]`;
  }

  try {
    const ai = getClient();

    const prompt = caption
      ? `The user sent this video with the message: "${caption}"\n\nDescribe the video content and address the user's message.`
      : 'Describe the content of this video in detail.';

    const response = await ai.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents: [
        { inlineData: { mimeType, data: buffer.toString('base64') } },
        prompt,
      ],
    });

    return response.text ?? '';
  } catch (err) {
    logger.error({ err }, 'analyzeVideo failed');
    throw err;
  }
}

/**
 * Transcribe audio using Gemini Flash.
 * Returns the transcription text, or null if transcription failed or is empty.
 * @param buffer   Raw audio bytes
 * @param mimeType MIME type (e.g. 'audio/ogg'). Defaults to 'audio/ogg'.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimeType?: string,
): Promise<string | null> {
  try {
    const ai = getClient();

    const response = await ai.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents: [
        {
          inlineData: {
            mimeType: mimeType || 'audio/ogg',
            data: buffer.toString('base64'),
          },
        },
        'Transcribe this audio message. Return only the transcribed text, nothing else.',
      ],
    });

    const text = (response.text ?? '').trim();
    return text || null;
  } catch (err) {
    logger.error({ err }, 'transcribeAudio failed');
    return null;
  }
}

export { WEB_FETCH_MAX_BYTES };
