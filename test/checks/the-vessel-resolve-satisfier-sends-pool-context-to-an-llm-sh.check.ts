import { describe, it, expect, mock, afterEach } from "bun:test";
import * as mod from "../../src/index";

describe("vessel-resolve satisfier prompt generation", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("FAIL: llm_completion_dispatch prompt should include content from pool variables", async () => {
        const fetchCalls: any[] = [];
        globalThis.fetch = mock(async (resource: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
            const url = resource.toString();
            let body: any = null;
            if (options?.body) {
                try {
                    body = JSON.parse(options.body.toString());
                } catch (e) {
                    // Not a JSON body
                }
            }
            fetchCalls.push({ url, options, body });

            if (body?.pointer?.type === "llm.completion") {
                return new Response(JSON.stringify({
                    body: {
                        content: [{ type: "text", text: "Mocked LLM response" }]
                    }
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        const requestBody = {
            impulse: {
                pointer: {
                    shape: "llm_completion_dispatch",
                    goal: "Summarize the context.",
                }
            },
            pool: [
                { shape: "referencedRun", content: "This is a very important piece of context from a previous step." }
            ]
        };

        const request = new Request("http://localhost/v2/impulses/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        await mod.handleResolve(request);

        const llmCall = fetchCalls.find(call => call.body?.pointer?.type === 'llm.completion');
        
        expect(llmCall).toBeDefined();
        
        const messages = llmCall.body.body?.messages;
        expect(messages).toBeInstanceOf(Array);
        
        const promptText = messages.map((m: any) => m.content).join("\n");
        
        expect(promptText).toContain("This is a very important piece of context from a previous step.");
    });

    it("CONTROL: passes for llm_completion_dispatch resolves that do not use the pool", async () => {
        const fetchCalls: any[] = [];
        globalThis.fetch = mock(async (resource: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
            let body: any = null;
            if (options?.body) { body = JSON.parse(options.body.toString()); }
            fetchCalls.push({ body });

            if (body?.pointer?.type === "llm.completion") {
                return new Response(JSON.stringify({
                    body: { content: [{ type: "text", text: "Mocked LLM response" }] }
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        });
        
        const requestBody = {
            impulse: {
                pointer: {
                    shape: "llm_completion_dispatch",
                    goal: "Just say hello.",
                }
            },
            pool: []
        };

        const request = new Request("http://localhost/v2/impulses/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        await mod.handleResolve(request);

        const llmCall = fetchCalls.find(call => call.body?.pointer?.type === 'llm.completion');
        expect(llmCall).toBeDefined();
        
        const messages = llmCall.body.body?.messages;
        expect(messages).toBeInstanceOf(Array);
        
        const promptText = messages.map((m: any) => m.content).join("\n");
        
        expect(promptText).toContain("Just say hello.");
        expect(promptText).not.toContain("This is a very important piece of context");
    });
});
