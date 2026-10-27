/**
 * Client for XERJ - the local-first search engine for AI agents (Elasticsearch wire-compatible).
 * Performs passage and definition retrieval for Reference Coding.
 */

export interface XerjHit {
  file: string;
  title?: string;
  score: number;
  passage?: string;
  line?: number;
}

export interface XerjSearchResult {
  query: string;
  available: boolean;
  total: number;
  hits: XerjHit[];
}

export interface XerjClientOptions {
  url?: string;
  defaultIndex?: string;
  timeoutMs?: number;
}

export class XerjClient {
  readonly url: string;
  readonly defaultIndex: string;
  private readonly timeoutMs: number;

  constructor(options: XerjClientOptions = {}) {
    this.url = (options.url ?? process.env.XERJ_URL ?? 'http://127.0.0.1:9200').replace(/\/+$/, '');
    this.defaultIndex = options.defaultIndex ?? process.env.XERJ_DEFAULT_INDEX ?? 'mcp-bridge-docs';
    this.timeoutMs = options.timeoutMs ?? 1500;
  }

  /**
   * Check if the XERJ daemon is reachable and responding.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 800);
      const res = await fetch(`${this.url}/`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available indices on the XERJ node.
   */
  async listIndices(): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(`${this.url}/_cat/indices?format=json`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return [];
      const data = await res.json() as Array<{ index?: string }>;
      return data.map(item => item.index).filter((idx): idx is string => Boolean(idx));
    } catch {
      return [];
    }
  }

  /**
   * Search code passages using AST definition-weighted BM25 search.
   */
  async search(query: string, options: { index?: string; limit?: number } = {}): Promise<XerjSearchResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { query, available: true, total: 0, hits: [] };
    }

    const index = options.index ?? this.defaultIndex;
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20));

    const payload = {
      query: {
        bool: {
          should: [
            {
              multi_match: {
                query: trimmed,
                fields: ['body', 'defs'],
                type: 'most_fields'
              }
            },
            {
              match_phrase: {
                defs: {
                  query: trimmed,
                  boost: 4
                }
              }
            }
          ]
        }
      },
      _source: ['ax_path', 'title', 'start_line'],
      fields: ['_passage'],
      size: limit
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(`${this.url}/${encodeURIComponent(index)}/_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        return { query: trimmed, available: true, total: 0, hits: [] };
      }

      const body = await res.json() as {
        hits?: {
          total?: { value?: number } | number;
          hits?: Array<{
            _score: number;
            _source?: { ax_path?: string; title?: string; start_line?: number };
            fields?: { _passage?: Array<{ text?: string }> };
          }>;
        };
      };

      const rawTotal = body.hits?.total;
      const total = typeof rawTotal === 'number' ? rawTotal : (rawTotal?.value ?? 0);
      const rawHits = body.hits?.hits ?? [];

      const hits: XerjHit[] = rawHits.map(hit => {
        const passage = hit.fields?._passage?.[0]?.text?.trim();
        const file = hit._source?.ax_path || hit._source?.title || 'unknown';
        return {
          file,
          title: hit._source?.title,
          score: hit._score,
          passage: passage && passage.length > 0 ? passage : undefined,
          line: hit._source?.start_line
        };
      });

      return {
        query: trimmed,
        available: true,
        total,
        hits
      };
    } catch {
      return {
        query: trimmed,
        available: false,
        total: 0,
        hits: []
      };
    }
  }

  /**
   * Format relevant passages into a clean prompt context block for Reference Coding.
   */
  formatPassagesForPrompt(hits: XerjHit[], maxChars = 2500): string {
    const hitsWithPassage = hits.filter(h => Boolean(h.passage));
    if (hitsWithPassage.length === 0) return '';

    const lines: string[] = [
      '--- Relevant Codebase Reference (from XERJ) ---'
    ];

    let currentLength = lines[0].length + 1;

    for (const hit of hitsWithPassage) {
      const header = `[File: ${hit.file}${hit.line ? ` (line ${hit.line})` : ''} | score: ${hit.score.toFixed(1)}]`;
      const snippet = hit.passage!;
      const chunk = `${header}\n${snippet}\n`;

      if (currentLength + chunk.length > maxChars && lines.length > 1) {
        break;
      }

      lines.push(header);
      lines.push(snippet);
      lines.push('');
      currentLength += chunk.length;
    }

    lines.push('-----------------------------------------------');
    return lines.join('\n');
  }
}
