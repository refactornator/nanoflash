/**
 * Gemini Media Analysis — host-side media processing for nanoflash.
 * Runs on the host (not inside the container).
 *
 * NOTE: Direct API key usage is intentional here — this runs on the host
 * process which already reads .env. No container or subprocess is involved.
 *
 * Video and audio are uploaded via the Gemini File API (supports up to 2 GB)
 * rather than sent as inline base64 (20 MB limit). Images stay inline since
 * they are rarely large enough to need the File API round-trip.
 */
import { FileState, GoogleGenAI, type File as GeminiFile } from '@google/genai';
import {
  GEMINI_API_KEY,
  GEMINI_FAST_MODEL,
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
 * Upload a buffer to the Gemini File API and wait until it is ACTIVE.
 * Files are automatically deleted after 48 hours.
 */
async function uploadAndWait(
  ai: GoogleGenAI,
  buffer: Buffer,
  mimeType: string,
  displayName: string,
): Promise<GeminiFile> {
  const blob = new Blob([buffer], { type: mimeType });
  let file = await ai.files.upload({ file: blob, config: { mimeType, displayName } });

  // Poll until the file leaves PROCESSING state (usually <5 s for audio, a few seconds for video)
  while (file.state === FileState.PROCESSING) {
    await new Promise((r) => setTimeout(r, 1_000));
    file = await ai.files.get({ name: file.name! });
  }

  if (file.state === FileState.FAILED) {
    throw new Error(`Gemini file processing failed: ${file.error?.message ?? 'unknown error'}`);
  }

  return file;
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
 * Analyse a video using Gemini Flash via the File API. Returns a text description.
 * Uploads the video to Gemini (up to 2 GB) rather than sending it as inline
 * base64, which is limited to 20 MB.
 * @param buffer   Raw video bytes
 * @param mimeType MIME type (e.g. 'video/mp4')
 * @param caption  Optional caption from the sender
 */
export async function analyzeVideo(
  buffer: Buffer,
  mimeType: string,
  caption?: string,
): Promise<string> {
  try {
    const ai = getClient();
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
    logger.info({ sizeMB, mimeType }, 'Uploading video to Gemini File API');

    const file = await uploadAndWait(ai, buffer, mimeType, 'video');

    const prompt = caption
      ? `The user sent this video with the message: "${caption}"\n\nDescribe the video content and address the user's message.`
      : 'Describe the content of this video in detail.';

    const response = await ai.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents: [
        { fileData: { fileUri: file.uri!, mimeType } },
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
 * Transcribe audio using Gemini Flash via the File API.
 * Uploads the audio to Gemini rather than sending it as inline base64.
 * Returns the transcription text, or null if transcription failed or is empty.
 * @param buffer   Raw audio bytes
 * @param mimeType MIME type (e.g. 'audio/ogg'). Defaults to 'audio/ogg'.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimeType?: string,
): Promise<string | null> {
  const resolvedMime = mimeType || 'audio/ogg';
  try {
    const ai = getClient();

    const file = await uploadAndWait(ai, buffer, resolvedMime, 'audio');

    const response = await ai.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents: [
        { fileData: { fileUri: file.uri!, mimeType: resolvedMime } },
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
