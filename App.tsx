
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SUPPORTED_LANGUAGES, APP_CONFIG } from './constants';
import { TranslationStatus, Language } from './types';
import { translateText, translateTextStream, translateDocument, generateSpeech, decodeGeminiPCM, getAIInstance, createAudioBlob } from './services/geminiService';
import { Modality, LiveServerMessage } from '@google/genai';
import mammoth from 'mammoth';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'text' | 'document'>('text');
  const [sourceText, setSourceText] = useState('');
  const [targetText, setTargetText] = useState('');
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('es');
  const [status, setStatus] = useState<TranslationStatus>(TranslationStatus.IDLE);
  const [detectedLang, setDetectedLang] = useState('');
  const [confidence, setConfidence] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // Undo/Redo states
  const [history, setHistory] = useState<string[]>(['']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const isInternalChange = useRef(false);

  // Document specific state
  const [isDocumentProcessing, setIsDocumentProcessing] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [translatedDocContent, setTranslatedDocContent] = useState<string | null>(null);

  // Selection Translation States
  const [selection, setSelection] = useState<{ text: string, x: number, y: number } | null>(null);
  const [selectionTargetLang, setSelectionTargetLang] = useState('en');
  const [selectionResult, setSelectionResult] = useState<string | null>(null);
  const [isTranslatingSelection, setIsTranslatingSelection] = useState(false);
  
  // Refs
  const typingTimeoutRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const targetAreaRef = useRef<HTMLDivElement>(null);
  const activeStreamRef = useRef<number>(0);
  
  // Voice Input Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const liveSessionPromiseRef = useRef<Promise<any> | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const handleTranslate = useCallback(async (text: string) => {
    if (!text.trim()) {
      setTargetText('');
      setDetectedLang('');
      setConfidence(0);
      return;
    }

    const streamId = ++activeStreamRef.current;
    setStatus(TranslationStatus.LOADING);
    setError(null);
    setTargetText(''); // Clear for streaming start
    
    try {
      let fullText = '';
      const stream = translateTextStream(text, sourceLang, targetLang);
      
      for await (const chunk of stream) {
        if (streamId !== activeStreamRef.current) return; // Abort if newer request
        fullText += chunk;
        setTargetText(fullText);
      }
      
      // After streaming text, do a final structured call to get detected language and confidence
      // only if source is set to auto or we need accuracy data.
      if (sourceLang === 'auto') {
        const result = await translateText(text, sourceLang, targetLang);
        if (streamId !== activeStreamRef.current) return;
        setDetectedLang(result.detectedLanguage);
        setConfidence(result.confidence);
      }

      setStatus(TranslationStatus.SUCCESS);
    } catch (err: any) {
      if (streamId !== activeStreamRef.current) return;
      console.error(err);
      setError(err.message || 'Translation failed. Please try again.');
      setStatus(TranslationStatus.ERROR);
    }
  }, [sourceLang, targetLang]);

  // Undo / Redo logic
  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      isInternalChange.current = true;
      const prevText = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setSourceText(prevText);
    }
  }, [history, historyIndex]);

  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      isInternalChange.current = true;
      const nextText = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setSourceText(nextText);
    }
  }, [history, historyIndex]);

  // History tracking effect
  useEffect(() => {
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }

    const timer = setTimeout(() => {
      if (sourceText !== history[historyIndex]) {
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(sourceText);
        if (newHistory.length > 50) newHistory.shift();
        setHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [sourceText, history, historyIndex]);

  // Restore from localStorage on mount
  useEffect(() => {
    const savedText = localStorage.getItem('lingoai_source_text');
    if (savedText) {
      setSourceText(savedText);
      setHistory([savedText]);
      setHistoryIndex(0);
      setLastSaved(new Date());
    }
  }, []);

  // Save to localStorage on change
  useEffect(() => {
    if (activeTab === 'text') {
      localStorage.setItem('lingoai_source_text', sourceText);
      if (sourceText.length > 0) {
        setLastSaved(new Date());
      } else {
        setLastSaved(null);
      }
    }
  }, [sourceText, activeTab]);

  // Debounced translation effect - Faster for real-time feel
  useEffect(() => {
    if (activeTab !== 'text') return;
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    
    if (sourceText.length > 0 && !isRecording) {
      typingTimeoutRef.current = window.setTimeout(() => {
        handleTranslate(sourceText);
      }, 300); // Fast 300ms debounce
    } else if (sourceText.length === 0) {
      setTargetText('');
      setDetectedLang('');
      setConfidence(0);
      setStatus(TranslationStatus.IDLE);
    }

    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [sourceText, handleTranslate, isRecording, activeTab]);

  const handleSwap = useCallback(() => {
    if (sourceLang === 'auto') return;
    const prevSource = sourceLang;
    const prevTarget = targetLang;
    setSourceLang(prevTarget);
    setTargetLang(prevSource);
    setSourceText(targetText);
    setTargetText(sourceText);
  }, [sourceLang, targetLang, sourceText, targetText]);

  const handleClear = useCallback(() => {
    setSourceText('');
    setTargetText('');
    setDetectedLang('');
    setConfidence(0);
    setError(null);
    setStatus(TranslationStatus.IDLE);
    setSelection(null);
    setUploadedFileName(null);
    setTranslatedDocContent(null);
    localStorage.removeItem('lingoai_source_text');
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadedFileName(file.name);
    setTranslatedDocContent(null);
    setError(null);

    if (activeTab === 'text') {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        setSourceText(content);
      };
      reader.readAsText(file);
    } else {
      await handleDocumentModeFile(file);
    }
  };

  const handleDocumentModeFile = async (file: File) => {
    setIsDocumentProcessing(true);
    try {
      let contentBase64 = '';
      let mimeType = file.type;

      if (mimeType === 'application/pdf') {
        const reader = new FileReader();
        contentBase64 = await new Promise((resolve) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(file);
        });
      } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.endsWith('.docx')) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        const textContent = result.value;
        const translated = await translateDocument(btoa(textContent), 'text/plain', sourceLang, targetLang);
        setTranslatedDocContent(translated);
        setIsDocumentProcessing(false);
        return;
      } else if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
        const reader = new FileReader();
        contentBase64 = await new Promise((resolve) => {
          reader.onload = () => resolve(btoa(reader.result as string));
          reader.readAsText(file);
        });
      } else {
        throw new Error('Unsupported file type. Please upload a PDF, DOCX, or TXT file.');
      }

      const translated = await translateDocument(contentBase64, mimeType || 'text/plain', sourceLang, targetLang);
      setTranslatedDocContent(translated);
    } catch (err: any) {
      console.error('Document error:', err);
      setError(err.message || 'Failed to translate document.');
    } finally {
      setIsDocumentProcessing(false);
    }
  };

  const handleDownload = () => {
    if (!translatedDocContent) return;
    const blob = new Blob([translatedDocContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `translated_${uploadedFileName?.split('.')[0] || 'document'}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Voice Input Logic
  const stopVoiceInput = useCallback(async () => {
    if (liveSessionPromiseRef.current) {
      const session = await liveSessionPromiseRef.current;
      session.close();
      liveSessionPromiseRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    const nodes = (window as any)._voiceNodes;
    if (nodes) {
      nodes.source.disconnect();
      nodes.scriptProcessor.disconnect();
      delete (window as any)._voiceNodes;
    }
    setIsRecording(false);
  }, []);

  const startVoiceInput = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      
      const ai = getAIInstance();
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      
      liveSessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsRecording(true);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createAudioBlob(inputData);
              liveSessionPromiseRef.current?.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
            (window as any)._voiceNodes = { source, scriptProcessor };
          },
          onmessage: (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setSourceText(prev => (prev ? prev + ' ' + text : text));
            }
          },
          onerror: (e) => {
            console.error('Live API Error:', e);
            stopVoiceInput();
          },
          onclose: () => {
            setIsRecording(false);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: 'Transcribe user speech exactly as heard. Do not generate responses, just transcribe.'
        }
      });
    } catch (err: any) {
      console.error('Failed to start voice input:', err);
      setError('Microphone access denied or connection failed.');
    }
  }, [stopVoiceInput]);

  const toggleVoiceInput = useCallback(() => {
    if (isRecording) {
      stopVoiceInput();
    } else {
      startVoiceInput();
    }
  }, [isRecording, startVoiceInput, stopVoiceInput]);

  // Keyboard Shortcuts Effect
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) handleRedo();
          else handleUndo();
        } else if (key === 'y') {
          e.preventDefault();
          handleRedo();
        }
      }

      if (e.ctrlKey && e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'c') {
          e.preventDefault();
          handleClear();
        } else if (key === 's') {
          e.preventDefault();
          handleSwap();
        } else if (key === 'v') {
          e.preventDefault();
          toggleVoiceInput();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClear, handleSwap, toggleVoiceInput, handleUndo, handleRedo]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleSpeak = async (text: string) => {
    if (!text || isSpeaking) return;
    setIsSpeaking(true);
    
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      
      const audioData = await generateSpeech(text);
      const audioBuffer = await decodeGeminiPCM(audioData, audioContextRef.current!);
      
      const source = audioContextRef.current!.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContextRef.current!.destination);
      source.onended = () => setIsSpeaking(false);
      source.start();
    } catch (err) {
      console.error('Speech error:', err);
      setIsSpeaking(false);
    }
  };

  const handleTextSelection = () => {
    const activeSelection = window.getSelection();
    if (activeSelection && activeSelection.toString().trim().length > 0) {
      const range = activeSelection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      
      if (targetAreaRef.current && targetAreaRef.current.contains(activeSelection.anchorNode)) {
        setSelection({
          text: activeSelection.toString().trim(),
          x: rect.left + rect.width / 2,
          y: rect.top + window.scrollY - 10
        });
        setSelectionResult(null);
      }
    } else {
      if (!isTranslatingSelection) setSelection(null);
    }
  };

  const translateSelectedText = async () => {
    if (!selection) return;
    setIsTranslatingSelection(true);
    try {
      const result = await translateText(selection.text, 'auto', selectionTargetLang);
      setSelectionResult(result.translatedText);
    } catch (err) {
      console.error("Selection translation failed", err);
      setSelectionResult("Error translating selection.");
    } finally {
      setIsTranslatingSelection(false);
    }
  };

  return (
    <div className="min-h-screen pb-12" onMouseUp={handleTextSelection}>
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-xl">
              L
            </div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">{APP_CONFIG.NAME}</h1>
          </div>
          <nav className="flex items-center gap-6 text-sm font-medium text-slate-600">
            <button 
              onClick={() => setActiveTab('text')}
              className={`pb-5 pt-5 border-b-2 transition-all ${activeTab === 'text' ? 'text-blue-600 border-blue-600' : 'text-slate-500 border-transparent hover:text-slate-900'}`}
            >
              Text
            </button>
            <button 
              onClick={() => setActiveTab('document')}
              className={`pb-5 pt-5 border-b-2 transition-all ${activeTab === 'document' ? 'text-blue-600 border-blue-600' : 'text-slate-500 border-transparent hover:text-slate-900'}`}
            >
              Documents
            </button>
          </nav>
          <div className="flex items-center gap-2">
            <button className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition-colors">
              Sign In
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 mt-8">
        <div className="flex flex-col gap-6">
          
          {/* Main UI Container */}
          {activeTab === 'text' ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Source Panel */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between glass-panel px-4 py-2 rounded-xl">
                  <div className="flex items-center gap-2">
                    <select 
                      value={sourceLang}
                      onChange={(e) => setSourceLang(e.target.value)}
                      className="bg-transparent text-sm font-semibold text-slate-700 focus:outline-none cursor-pointer"
                    >
                      {SUPPORTED_LANGUAGES.map(lang => (
                        <option key={lang.code} value={lang.code}>
                          {lang.name} {lang.code === 'auto' && detectedLang ? `(${detectedLang})` : ''}
                        </option>
                      ))}
                    </select>
                    {sourceLang === 'auto' && detectedLang && confidence > 0 && (
                      <div className="flex items-center gap-1 group relative">
                        <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[10px] font-bold rounded-full border border-blue-100 transition-all cursor-help hover:bg-blue-100">
                          {Math.round(confidence * 100)}% Match
                        </span>
                        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block w-32 bg-slate-800 text-white text-[10px] p-2 rounded shadow-lg z-20 pointer-events-none">
                          AI confidence score for the detected language.
                          <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-slate-800"></div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                     <button 
                      onClick={handleUndo}
                      disabled={historyIndex === 0}
                      title="Undo (Ctrl+Z)"
                      className="p-2 text-slate-400 hover:text-blue-600 disabled:opacity-20 transition-colors rounded-full hover:bg-blue-50"
                     >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                        </svg>
                     </button>
                     <button 
                      onClick={handleRedo}
                      disabled={historyIndex >= history.length - 1}
                      title="Redo (Ctrl+Y)"
                      className="p-2 text-slate-400 hover:text-blue-600 disabled:opacity-20 transition-colors rounded-full hover:bg-blue-50"
                     >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10h-10a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6" />
                        </svg>
                     </button>
                     <div className="w-px h-6 bg-slate-200 mx-1"></div>
                     <button 
                      onClick={toggleVoiceInput}
                      title={isRecording ? "Stop Recording (Ctrl+Shift+V)" : "Voice Input (Ctrl+Shift+V)"}
                      className={`p-2 transition-all rounded-full ${isRecording ? 'text-red-500 bg-red-50 animate-pulse' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'}`}
                     >
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                       </svg>
                     </button>
                     <button 
                      onClick={handleClear}
                      title="Clear All (Ctrl+Shift+C)"
                      className="p-2 text-slate-400 hover:text-red-500 transition-colors rounded-full hover:bg-red-50"
                     >
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                       </svg>
                     </button>
                     <label className="cursor-pointer text-slate-500 hover:text-blue-600 transition-colors p-2 rounded-full hover:bg-blue-50" title="Upload Text File">
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                       </svg>
                       <input type="file" className="hidden" accept=".txt,.md,.rtf" onChange={handleFileUpload} />
                     </label>
                  </div>
                </div>

                <div className="relative glass-panel rounded-2xl shadow-sm min-h-[300px]">
                  <textarea
                    value={sourceText}
                    onChange={(e) => setSourceText(e.target.value)}
                    placeholder={isRecording ? "Listening..." : "Enter text here..."}
                    className="w-full h-full p-6 bg-transparent resize-none focus:outline-none text-lg text-slate-800"
                    rows={8}
                  />
                  <div className="absolute bottom-4 left-4 flex gap-2">
                     <button 
                      onClick={() => handleSpeak(sourceText)}
                      disabled={!sourceText || isSpeaking}
                      className="p-2 text-slate-400 hover:text-blue-600 disabled:opacity-30"
                     >
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                         <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.983 5.983 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.984 3.984 0 00-1.172-2.828 1 1 0 010-1.415z" clipRule="evenodd" />
                       </svg>
                     </button>
                  </div>
                  <div className="absolute bottom-4 right-4 flex items-center gap-3">
                    {lastSaved && (
                      <span className="text-[10px] text-emerald-500 font-medium flex items-center gap-1 animate-in fade-in slide-in-from-right-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                        Draft saved
                      </span>
                    )}
                    <span className="text-xs text-slate-400">
                      {sourceText.length} characters
                    </span>
                  </div>
                </div>
              </div>

              {/* Swap Button */}
              <div className="flex items-center justify-center -my-2 lg:my-0 lg:absolute lg:left-1/2 lg:top-1/2 lg:-translate-x-1/2 lg:-translate-y-1/2 z-10">
                <button 
                  onClick={handleSwap}
                  disabled={sourceLang === 'auto'}
                  title="Swap Languages (Ctrl+Shift+S)"
                  className="w-10 h-10 bg-white border border-slate-200 rounded-full shadow-md flex items-center justify-center hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-600 rotate-90 lg:rotate-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                </button>
              </div>

              {/* Target Panel */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between glass-panel px-4 py-2 rounded-xl">
                  <select 
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="bg-transparent text-sm font-semibold text-slate-700 focus:outline-none cursor-pointer"
                  >
                    {SUPPORTED_LANGUAGES.filter(l => l.code !== 'auto').map(lang => (
                      <option key={lang.code} value={lang.code}>
                        {lang.name}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center gap-2">
                     {status === TranslationStatus.LOADING && (
                        <div className="flex gap-1">
                          <div className="w-1 h-1 bg-blue-600 rounded-full animate-bounce"></div>
                          <div className="w-1 h-1 bg-blue-600 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                          <div className="w-1 h-1 bg-blue-600 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                        </div>
                     )}
                  </div>
                </div>

                <div 
                  ref={targetAreaRef}
                  className={`relative glass-panel rounded-2xl shadow-sm min-h-[300px] transition-colors ${status === TranslationStatus.ERROR ? 'border-red-200 bg-red-50/10' : ''}`}
                >
                  <div className="p-6 text-lg text-slate-800 whitespace-pre-wrap select-text">
                    {(status === TranslationStatus.LOADING && !targetText) ? (
                      <div className="space-y-3 animate-pulse">
                        <div className="h-4 bg-slate-100 rounded w-3/4"></div>
                        <div className="h-4 bg-slate-100 rounded w-1/2"></div>
                        <div className="h-4 bg-slate-100 rounded w-5/6"></div>
                      </div>
                    ) : (
                      targetText || (
                        <span className="text-slate-300 italic">Translation will appear here...</span>
                      )
                    )}
                  </div>

                  {error && (
                    <div className="absolute inset-x-0 top-0 p-4 text-center">
                      <span className="text-xs bg-red-100 text-red-600 px-3 py-1 rounded-full font-medium">{error}</span>
                    </div>
                  )}

                  <div className="absolute bottom-4 left-4 flex gap-2">
                    <button 
                      onClick={() => handleSpeak(targetText)}
                      disabled={!targetText || isSpeaking}
                      className="p-2 text-slate-400 hover:text-blue-600 transition-colors disabled:opacity-30"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.983 5.983 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.984 3.984 0 00-1.172-2.828 1 1 0 010-1.415z" clipRule="evenodd" />
                      </svg>
                    </button>
                    <button 
                      onClick={() => copyToClipboard(targetText)}
                      disabled={!targetText}
                      className="p-2 text-slate-400 hover:text-blue-600 transition-colors disabled:opacity-30"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                        <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Document Mode UI */
            <div className="glass-panel rounded-3xl p-12 flex flex-col items-center justify-center text-center">
              <div className="w-24 h-24 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mb-6">
                 <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                 </svg>
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Translate any document</h2>
              <p className="text-slate-500 mb-8 max-w-md">Upload PDF, DOCX, or Text files and translate them instantly while preserving formatting.</p>
              
              <div className="w-full max-w-xl flex flex-col gap-6">
                <div className="flex items-center gap-4 justify-center">
                  <select 
                    value={sourceLang}
                    onChange={(e) => setSourceLang(e.target.value)}
                    className="px-4 py-2 border border-slate-200 rounded-xl bg-white text-sm font-semibold"
                  >
                    {SUPPORTED_LANGUAGES.map(l => (
                      <option key={l.code} value={l.code}>{l.name}</option>
                    ))}
                  </select>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                  <select 
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="px-4 py-2 border border-slate-200 rounded-xl bg-white text-sm font-semibold"
                  >
                    {SUPPORTED_LANGUAGES.filter(l => l.code !== 'auto').map(l => (
                      <option key={l.code} value={l.code}>{l.name}</option>
                    ))}
                  </select>
                </div>

                {!isDocumentProcessing && !translatedDocContent && (
                  <label className="border-2 border-dashed border-slate-200 rounded-3xl p-12 cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-all flex flex-col items-center gap-4">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    <span className="font-semibold text-slate-700">Choose a file or drag it here</span>
                    <span className="text-xs text-slate-400">Supported types: PDF, DOCX, TXT</span>
                    <input type="file" className="hidden" accept=".pdf,.docx,.txt" onChange={handleFileUpload} />
                  </label>
                )}

                {isDocumentProcessing && (
                  <div className="p-8 bg-blue-50/50 rounded-3xl border border-blue-100 flex flex-col gap-4 animate-in fade-in zoom-in duration-300">
                    <div className="flex items-center justify-between text-sm font-semibold text-blue-600">
                      <span>Translating {uploadedFileName}...</span>
                      <span className="animate-pulse">Processing...</span>
                    </div>
                    <div className="h-2 w-full bg-blue-100 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full animate-progress"></div>
                    </div>
                    <p className="text-xs text-slate-400 italic">This usually takes about 10-20 seconds for large documents.</p>
                  </div>
                )}

                {translatedDocContent && (
                  <div className="p-8 bg-emerald-50 rounded-3xl border border-emerald-100 flex flex-col items-center gap-6 animate-in slide-in-from-bottom-4 duration-500">
                    <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">Translation Complete!</h3>
                      <p className="text-sm text-slate-500">Your translated document is ready to download.</p>
                    </div>
                    <div className="flex gap-4">
                      <button 
                        onClick={handleDownload}
                        className="px-8 py-3 bg-blue-600 text-white font-bold rounded-2xl hover:bg-blue-700 transition-all flex items-center gap-2"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download (.txt)
                      </button>
                      <button 
                        onClick={handleClear}
                        className="px-8 py-3 bg-white border border-slate-200 text-slate-600 font-bold rounded-2xl hover:bg-slate-50 transition-all"
                      >
                        Start Over
                      </button>
                    </div>
                  </div>
                )}

                {error && (
                  <div className="p-4 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm font-medium">
                    {error}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Selection Tooltip Portal */}
          {selection && (
            <div 
              className="fixed z-50 bg-white shadow-xl rounded-lg border border-slate-200 overflow-hidden min-w-[200px]"
              style={{ left: selection.x, top: selection.y, transform: 'translate(-50%, -100%)' }}
            >
              <div className="flex items-center gap-2 p-2 bg-slate-50 border-b border-slate-200">
                <span className="text-[10px] uppercase font-bold text-slate-400">Translate selection to:</span>
                <select 
                  value={selectionTargetLang}
                  onChange={(e) => setSelectionTargetLang(e.target.value)}
                  className="bg-white border border-slate-200 rounded text-xs px-1 focus:outline-none"
                >
                  {SUPPORTED_LANGUAGES.filter(l => l.code !== 'auto').map(lang => (
                    <option key={lang.code} value={lang.code}>{lang.name}</option>
                  ))}
                </select>
                <button 
                  onClick={translateSelectedText}
                  className="ml-auto bg-blue-600 text-white text-[10px] font-bold px-2 py-1 rounded hover:bg-blue-700 transition-colors"
                >
                  {isTranslatingSelection ? '...' : 'GO'}
                </button>
                <button onClick={() => setSelection(null)} className="text-slate-400 hover:text-slate-600">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
              {selectionResult && (
                <div className="p-3 text-sm text-slate-700 bg-blue-50/30 max-h-[150px] overflow-y-auto italic">
                  {selectionResult}
                </div>
              )}
            </div>
          )}

          {/* Features Section */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
            <div className="p-6 bg-white rounded-2xl border border-slate-100 shadow-sm">
              <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-lg flex items-center justify-center mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-slate-900 mb-2">Instant AI Speed</h3>
              <p className="text-slate-500 text-sm leading-relaxed">Experience zero-lag translation powered by the latest Gemini 3 model for rapid multilingual communication.</p>
            </div>
            <div className="p-6 bg-white rounded-2xl border border-slate-100 shadow-sm">
              <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-lg flex items-center justify-center mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-slate-900 mb-2">Precision Accuracy</h3>
              <p className="text-slate-500 text-sm leading-relaxed">LingoAI understands context, idioms, and industry jargon, providing human-like translation results.</p>
            </div>
            <div className="p-6 bg-white rounded-2xl border border-slate-100 shadow-sm">
              <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-slate-900 mb-2">Natural Voice</h3>
              <p className="text-slate-500 text-sm leading-relaxed">Listen to high-quality text-to-speech to learn correct pronunciation in any supported language.</p>
            </div>
          </section>
        </div>
      </main>

      <footer className="mt-24 border-t border-slate-200 pt-12 text-center text-slate-400 text-sm">
        <p>&copy; 2024 {APP_CONFIG.NAME}. Powered by Gemini AI.</p>
        <div className="flex justify-center gap-6 mt-4">
          <a href="#" className="hover:text-slate-600">Privacy Policy</a>
          <a href="#" className="hover:text-slate-600">Terms of Service</a>
          <a href="#" className="hover:text-slate-600">API Documentation</a>
        </div>
      </footer>
    </div>
  );
};

export default App;
