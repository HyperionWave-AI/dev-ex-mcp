// Knowledge API Client - uses existing MCP client patterns
import type { SearchRequest, SearchResponse, CreateRequest, CreateResponse, KnowledgeCollection } from '../types/knowledge';

// Use relative URL so Vite dev proxy handles routing (same pattern as mcpClient.ts)
// In production, nginx will proxy /api/knowledge to the coordinator MCP server
const API_BASE = '';

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('authToken');
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export const knowledgeApi = {
  async searchKnowledge(request: SearchRequest): Promise<SearchResponse> {
    const params = new URLSearchParams({
      collectionName: request.collection,
      query: request.query,
      limit: String(request.limit || 10)
    });

    const apiUrl = `${API_BASE}/api/knowledge/search?${params}`;
    console.log('[knowledgeApi] API Call:', apiUrl);
    console.log('[knowledgeApi] Request:', request);

    // Fetch raw MCP response
    const mcpResponse = await fetchWithAuth(apiUrl);
    console.log('[knowledgeApi] Raw MCP Response:', JSON.stringify(mcpResponse, null, 2));

    // Transform MCP format to expected SearchResponse format
    // MCP returns: {content: [{text: "[...JSON array...]", type: "text"}]}
    // We need: {results: KnowledgeEntry[], total: number}

    if (!mcpResponse.content || !mcpResponse.content[0] || !mcpResponse.content[0].text) {
      console.warn('[knowledgeApi] Invalid MCP response structure:', mcpResponse);
      return { results: [], total: 0 };
    }

    try {
      // Parse the JSON string within content[0].text
      console.log('[knowledgeApi] Parsing content[0].text:', mcpResponse.content[0].text.substring(0, 200));
      const results = JSON.parse(mcpResponse.content[0].text);
      console.log('[knowledgeApi] Parsed results:', results);

      const response = {
        results: Array.isArray(results) ? results : [],
        total: Array.isArray(results) ? results.length : 0
      };
      console.log('[knowledgeApi] Final SearchResponse:', response);
      return response;
    } catch (error) {
      console.error('[knowledgeApi] Failed to parse MCP search response:', error);
      console.error('[knowledgeApi] Raw text was:', mcpResponse.content[0].text);
      return { results: [], total: 0 };
    }
  },

  async createKnowledge(request: CreateRequest): Promise<CreateResponse> {
    return fetchWithAuth(`${API_BASE}/api/knowledge`, {
      method: 'POST',
      body: JSON.stringify({
        collectionName: request.collection,
        information: request.text,
        metadata: request.metadata
      })
    });
  },

  async listCollections(): Promise<{ collections: KnowledgeCollection[] }> {
    const mcpResponse = await fetchWithAuth(`${API_BASE}/api/knowledge/collections`);

    // Parse MCP resource format: { contents: [{ text: "JSON" }] }
    if (mcpResponse.contents && mcpResponse.contents[0] && mcpResponse.contents[0].text) {
      try {
        const data = JSON.parse(mcpResponse.contents[0].text);
        return {
          collections: (data.collections || []).map((col: any) => ({
            name: col.name,
            count: col.hasData ? 1 : 0, // Simplified - we don't have actual counts in the resource
            category: col.category
          }))
        };
      } catch (error) {
        console.error('[knowledgeApi] Failed to parse collections:', error);
        return { collections: [] };
      }
    }

    return { collections: [] };
  }
};
