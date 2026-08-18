/**
 * LLM Import Dialog Component
 *
 * Allows users to generate OpenAPI specifications using natural language
 * through an Ollama-powered chat interface with SSE streaming.
 */

'use client';

import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Send, Download, Sparkles, Bot, User, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/Dialog';
import { Button } from '../../../components/ui/Button';
import * as Select from '@radix-ui/react-select';
import { Markdown } from '@/app/components/ui/Markdown';

export interface LLMChatPanelProps {
  tenantId: string;
  userId: string;
  onImportSpec: (specContent: string) => void;
  /** When true, use compact layout (e.g. when embedded in a tab). Default false. */
  embedded?: boolean;
  className?: string;
  /** When provided, a Back button is shown to the left of the input (e.g. to return to tab choice). */
  onBack?: () => void;
}

interface LLMImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImportSpec: (specContent: string) => void;
  tenantId: string;
  userId: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
}

export const LLMChatPanel = forwardRef<{ abort: () => void } | null, LLMChatPanelProps>(function LLMChatPanel(
  { tenantId, userId, onImportSpec, embedded = false, className, onBack },
  ref
) {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [streamingContent, setStreamingContent] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useImperativeHandle(ref, () => ({
    abort: () => abortControllerRef.current?.abort(),
  }), []);

  // Load available models when mounted
  useEffect(() => {
    loadModels();
  }, []);

  const loadModels = async () => {
    setIsLoadingModels(true);
    try {
      const response = await fetch('/api/ollama/models');
      const data = await response.json();

      if (data.success && data.models) {
        setModels(data.models);
        // Auto-select first model
        if (data.models.length > 0 && !selectedModel) {
          setSelectedModel(data.models[0].name);
        }
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setIsLoadingModels(false);
    }
  };

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Handle sending a message
  const handleSendMessage = async () => {
    if (!input.trim() || !selectedModel || isLoading) return;

    const userMessage: Message = {
      role: 'user',
      content: input.trim(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setStreamingContent('');

    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('/api/ollama/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [...messages, userMessage],
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error('Failed to get response from LLM');
      }

      // Process SSE stream: update UI on every chunk for real-time streaming (Cursor-like).
      // Each chunk triggers a state update so text appears as it arrives, not in bursts.
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulatedContent = '';

      if (reader) {
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;

            if (line.startsWith('data: ')) {
              const data = line.slice(6);

              if (data === '[DONE]') {
                setStreamingContent(accumulatedContent);

                const assistantMessage: Message = {
                  role: 'assistant',
                  content: accumulatedContent,
                };
                setMessages(prev => [...prev, assistantMessage]);
                setStreamingContent('');
                break;
              }

              try {
                const event = JSON.parse(data);
                if (event.content) {
                  accumulatedContent += event.content;
                  setStreamingContent(accumulatedContent);
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        }
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('Error sending message:', error);
        const errorMessage: Message = {
          role: 'assistant',
          content: 'Sorry, I encountered an error processing your request. Please try again.',
        };
        setMessages(prev => [...prev, errorMessage]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortControllerRef.current = null;
    }
  };

  // Extract JSON specs from message content
  const extractJsonSpec = (content: string): string | null => {
    const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n```/;
    const match = content.match(jsonBlockRegex);
    return match ? match[1].trim() : null;
  };

  // Render message content with markdown formatting (shared <Markdown> + chat-specific components)
  const renderMessageContent = (content: string, isStreaming: boolean = false) => {
    return (
      <div>
        <Markdown
          variant="default"
          components={{
            // Customize code blocks
            code: ({ node, className, children, ...props }: any) => {
              const inline = !className?.includes('language-');
              const match = /language-(\w+)/.exec(className || '');
              const language = match ? match[1] : '';

              if (!inline && language === 'json') {
                // JSON code blocks get special styling
                return (
                  <div className="my-2 rounded-lg overflow-hidden border border-border-strong">
                    <div className="bg-inset px-3 py-1.5 border-b border-border">
                      <span className="text-xs font-mono text-fg-faint">JSON</span>
                    </div>
                    <pre className="bg-inset p-4 overflow-x-auto m-0">
                      <code className="text-sm font-mono text-ok" {...props}>
                        {children}
                      </code>
                    </pre>
                  </div>
                );
              } else if (!inline) {
                // Other code blocks
                return (
                  <div className="my-2 rounded-lg overflow-hidden border border-border-strong">
                    {language && (
                      <div className="bg-inset px-3 py-1.5 border-b border-border">
                        <span className="text-xs font-mono text-fg-faint">{language}</span>
                      </div>
                    )}
                    <pre className="bg-inset p-4 overflow-x-auto m-0">
                      <code className="text-sm font-mono text-fg" {...props}>
                        {children}
                      </code>
                    </pre>
                  </div>
                );
              } else {
                // Inline code
                return (
                  <code
                    className="px-1.5 py-0.5 rounded bg-inset text-fg text-sm font-mono"
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
            },
            // Customize paragraphs
            p: ({ children }) => (
              <p className="mb-2 last:mb-0">{children}</p>
            ),
            // Customize headings
            h1: ({ children }) => (
              <h1 className="text-xl font-bold mt-4 mb-2 first:mt-0">{children}</h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-lg font-bold mt-3 mb-2 first:mt-0">{children}</h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-base font-bold mt-2 mb-1 first:mt-0">{children}</h3>
            ),
            // Customize lists
            ul: ({ children }) => (
              <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>
            ),
            li: ({ children }) => (
              <li className="ml-2">{children}</li>
            ),
            // Customize links
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {children}
              </a>
            ),
            // Customize blockquotes
            blockquote: ({ children }) => (
              <blockquote className="border-l-4 border-border-strong pl-4 italic my-2">
                {children}
              </blockquote>
            ),
            // Customize tables
            table: ({ children }) => (
              <div className="overflow-x-auto my-2">
                <table className="min-w-full divide-y divide-border">
                  {children}
                </table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-inset">{children}</thead>
            ),
            th: ({ children }) => (
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-2 text-sm">{children}</td>
            ),
            // Customize horizontal rules
            hr: () => (
              <hr className="my-4 border-border-strong" />
            ),
          }}
          fallback={null}
        >
          {content}
        </Markdown>
        {isStreaming && (
          <span className="inline-block w-2 h-4 ml-1 bg-fg animate-pulse align-middle" />
        )}
      </div>
    );
  };

  // Handle importing a spec (caller is responsible for closing dialog when used in dialog)
  const handleImport = (content: string) => {
    const spec = extractJsonSpec(content);
    if (spec) {
      onImportSpec(spec);
    }
  };

  // Reset conversation
  const handleReset = () => {
    setMessages([]);
    setStreamingContent('');
    setInput('');
  };

  return (
    <div className={`flex flex-col min-h-0 ${embedded ? 'h-full' : ''} ${className ?? ''}`}>
        {/* Header */}
        {!embedded && (
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent rounded-lg">
              <Sparkles className="h-5 w-5 text-fg-on-accent" />
            </div>
            <div>
              <DialogTitle className="text-xl font-bold text-fg">
                Design with AI
              </DialogTitle>
              <p className="text-sm text-fg-muted mt-1">
                Generate OpenAPI specifications using natural language
              </p>
            </div>
          </div>
        </div>
        )}

        {/* Model Selection */}
        <div className="px-6 py-3 bg-subtle border-b border-border">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-fg">
              Model:
            </label>
            <Select.Root value={selectedModel} onValueChange={setSelectedModel} disabled={isLoadingModels || isLoading}>
              <Select.Trigger className="flex items-center gap-2 px-3 py-1.5 text-sm bg-surface border border-border-strong rounded-lg hover:bg-subtle transition-colors">
                <Select.Value placeholder={isLoadingModels ? 'Loading models...' : 'Select a model'} />
                <Select.Icon>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content className="bg-surface rounded-lg shadow-lg border border-border p-1 z-[10000]">
                  <Select.Viewport>
                    {models.map(model => (
                      <Select.Item
                        key={model.name}
                        value={model.name}
                        className="px-3 py-2 text-sm text-fg rounded-md outline-none cursor-pointer hover:bg-inset"
                      >
                        <Select.ItemText>{model.name}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>

            {messages.length > 0 && (
              <button
                onClick={handleReset}
                className="ms-auto px-3 py-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
              >
                Reset Conversation
              </button>
            )}
          </div>
        </div>

        {/* Messages Area — the wizard's own transcript column (`globals.css` §IMPORT WIZARD). */}
        <div className="imp-chat flex-1 overflow-y-auto p-6">
          {messages.length === 0 && !streamingContent && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 mb-4 bg-accent-soft rounded-2xl flex items-center justify-center">
                <Bot className="h-8 w-8 text-accent-fg" />
              </div>
              <h3 className="text-lg font-semibold text-fg mb-2">
                Start a Conversation
              </h3>
              <p className="text-sm text-fg-muted max-w-md">
                Describe the API you want to create, and I'll generate an OpenAPI 3.1.0 specification for you.
                You can refine it through conversation.
              </p>
              <div className="mt-6 grid grid-cols-1 gap-2 w-full max-w-lg">
                <button
                  onClick={() => setInput('Create a REST API for a simple blog with posts and comments')}
                  className="px-4 py-3 text-sm text-left text-fg bg-subtle hover:bg-inset rounded-lg transition-colors border border-border"
                >
                  💬 Create a blog API with posts and comments
                </button>
                <button
                  onClick={() => setInput('Generate an e-commerce API with products, orders, and customers')}
                  className="px-4 py-3 text-sm text-left text-fg bg-subtle hover:bg-inset rounded-lg transition-colors border border-border"
                >
                  🛒 E-commerce API with products and orders
                </button>
                <button
                  onClick={() => setInput('Build a user management API with authentication')}
                  className="px-4 py-3 text-sm text-left text-fg bg-subtle hover:bg-inset rounded-lg transition-colors border border-border"
                >
                  🔐 User management with authentication
                </button>
              </div>
            </div>
          )}

          {messages.map((message, index) => {
            const hasJsonSpec = extractJsonSpec(message.content) !== null;

            return (
              <div
                key={index}
                className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {message.role === 'assistant' && (
                  <div className="flex-shrink-0 w-8 h-8 bg-accent rounded-full flex items-center justify-center">
                    <Bot className="h-5 w-5 text-fg-on-accent" />
                  </div>
                )}

                <div className={`flex flex-col max-w-[80%] ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`imp-bubble ${
                      message.role === 'user' ? 'imp-bubble--user' : 'imp-bubble--ai'
                    }`}
                  >
                    <div className="text-sm">
                      {renderMessageContent(message.content)}
                    </div>
                  </div>

                  {message.role === 'assistant' && hasJsonSpec && (
                    <button
                      onClick={() => handleImport(message.content)}
                      className="mt-2 flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent-soft rounded-lg transition-colors"
                    >
                      <Download className="h-4 w-4" />
                      Import This Spec
                    </button>
                  )}
                </div>

                {message.role === 'user' && (
                  <div className="flex-shrink-0 w-8 h-8 bg-accent rounded-full flex items-center justify-center">
                    <User className="h-5 w-5 text-fg-on-accent" />
                  </div>
                )}
              </div>
            );
          })}

          {/* Thinking indicator */}
          {isLoading && !streamingContent && (
            <div className="flex gap-3 justify-start">
              <div className="flex-shrink-0 w-8 h-8 bg-accent rounded-full flex items-center justify-center">
                <Bot className="h-5 w-5 text-fg-on-accent" />
              </div>
              <div className="flex flex-col max-w-[80%]">
                <div className="px-4 py-3 rounded-lg bg-inset text-fg">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-fg-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-fg-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-fg-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <span className="text-sm text-fg-muted">Thinking...</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Streaming message */}
          {streamingContent && (
            <div className="flex gap-3 justify-start">
              <div className="flex-shrink-0 w-8 h-8 bg-accent rounded-full flex items-center justify-center">
                <Bot className="h-5 w-5 text-fg-on-accent" />
              </div>
              <div className="flex flex-col max-w-[80%]">
                <div className="px-4 py-3 rounded-lg bg-inset text-fg">
                  <div className="text-sm">
                    {renderMessageContent(streamingContent, true)}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t border-border p-4 bg-surface">
          <div className="flex gap-2 items-center">
            {onBack && (
              <Button type="button" variant="outline" onClick={onBack} className="shrink-0">
                Back
              </Button>
            )}
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
              placeholder="Describe your API or ask for changes..."
              disabled={isLoading || !selectedModel}
              className="flex-1 min-w-0 px-4 py-2 text-sm border border-border-strong rounded-lg bg-surface text-fg placeholder:text-fg-faint focus:ring-2 focus:ring-accent focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <Button
              onClick={handleSendMessage}
              disabled={isLoading || !input.trim() || !selectedModel}
              className="px-4 py-2 bg-ink hover:bg-[color-mix(in_srgb,var(--ink)_88%,black)] text-ink-fg rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </Button>
          </div>
          <p className="mt-2 mb-0 text-xs text-fg-muted text-center">
            AI can make mistakes — please review before importing.
          </p>
        </div>
    </div>
  );
});

/** Standalone dialog that wraps LLMChatPanel. Use this when opening Design with AI in its own dialog. */
export default function LLMImportDialog({
  open,
  onClose,
  onImportSpec,
  tenantId,
  userId,
}: LLMImportDialogProps) {
  const panelRef = useRef<{ abort: () => void } | null>(null);

  const handleClose = () => {
    panelRef.current?.abort();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0" aria-describedby={undefined}>
        <LLMChatPanel
          ref={panelRef}
          tenantId={tenantId}
          userId={userId}
          embedded={false}
          onImportSpec={(spec) => {
            onImportSpec(spec);
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

