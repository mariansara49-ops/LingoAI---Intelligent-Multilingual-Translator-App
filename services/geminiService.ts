
import { GoogleGenAI, Type, Modality, Blob, GenerateContentResponse } from "@google/genai";
import { TranslationResult } from "../types";
import { APP_CONFIG } from "../constants";

export const getAIInstance = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

export const translateText = async (
  text: string,
  sourceLang: string,
  targetLang: string
): Promise<TranslationResult> => {
  const ai = getAIInstance();
  
  const response = await ai.models.generateContent({
    model: APP_CONFIG.MODEL_TEXT,
    contents: `Translate the following text from ${sourceLang === 'auto' ? 'automatically detected language' : sourceLang} to ${targetLang}. 
    Original Text: "${text}"
    
    If source language is 'auto', first detect the language.
    Return only a JSON object with properties: "translatedText", "detectedLanguage", "confidence".`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          translatedText: { type: Type.STRING },
          detectedLanguage: { type: Type.STRING },
          confidence: { type: Type.NUMBER }
        },
        required: ["translatedText", "detectedLanguage", "confidence"]
      }
    }
  });

  return JSON.parse(response.text);
};

export async function* translateTextStream(
  text: string,
  sourceLang: string,
  targetLang: string
) {
  const ai = getAIInstance();
  
  const responseStream = await ai.models.generateContentStream({
    model: APP_CONFIG.MODEL_TEXT,
    contents: `Translate the following text from ${sourceLang === 'auto' ? 'automatically detected language' : sourceLang} to ${targetLang}. 
    Original Text: "${text}"
    
    Translate naturally and preserve context. Just return the translated text without any other labels or formatting.`,
  });

  for await (const chunk of responseStream) {
    const textPart = chunk.text;
    if (textPart) {
      yield textPart;
    }
  }
}

export const translateDocument = async (
  base64Data: string,
  mimeType: string,
  sourceLang: string,
  targetLang: string
): Promise<string> => {
  const ai = getAIInstance();
  
  const response = await ai.models.generateContent({
    model: APP_CONFIG.MODEL_TEXT,
    contents: {
      parts: [
        {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        },
        {
          text: `You are a professional document translator. Translate the content of this document into ${targetLang}. 
          ${sourceLang !== 'auto' ? `The source language is ${sourceLang}.` : 'Detect the source language automatically.'}
          Return ONLY the translated text. Preserve the original structure, headings, and formatting as much as possible in a plain text format.`
        }
      ]
    }
  });

  return response.text || "Failed to translate document.";
};

export const generateSpeech = async (text: string): Promise<ArrayBuffer> => {
  const ai = getAIInstance();
  
  const response = await ai.models.generateContent({
    model: APP_CONFIG.MODEL_TTS,
    contents: [{ parts: [{ text: `Say clearly and naturally: ${text}` }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("No audio data returned");

  // Helper to decode base64 to bytes
  const binaryString = atob(base64Audio);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return bytes.buffer;
};

// PCM Decoding Utility for Gemini TTS output
export async function decodeGeminiPCM(
  buffer: ArrayBuffer,
  ctx: AudioContext,
  sampleRate: number = 24000
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(buffer);
  const audioBuffer = ctx.createBuffer(1, dataInt16.length, sampleRate);
  const channelData = audioBuffer.getChannelData(0);
  
  for (let i = 0; i < dataInt16.length; i++) {
    channelData[i] = dataInt16[i] / 32768.0;
  }
  
  return audioBuffer;
}

// Encoding helpers for Live API
export function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function createAudioBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}
