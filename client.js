require('dotenv').config();
const { spawn } = require('child_process');
const readline = require('readline');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// Path to the MCP Server
const SERVER_PATH = './server.js';

// Spawns the MCP Server process
console.log(`[Client] Starting MCP Server: node ${SERVER_PATH}...`);
const serverProcess = spawn('node', [SERVER_PATH]);

// Setup readline interface for reading responses from the server's stdout
const serverRl = readline.createInterface({
    input: serverProcess.stdout,
    terminal: false
});

// Print server's stderr logs directly to client's console for visibility
serverProcess.stderr.on('data', (data) => {
    console.error(`[Server Log] ${data.toString().trim()}`);
});

serverProcess.on('exit', (code) => {
    console.log(`[Client] MCP Server process exited with code ${code}`);
    process.exit(code);
});

// JSON-RPC message tracker
let nextRequestId = 1;
const pendingRequests = new Map();

// Read line-by-line responses from the MCP server stdout
serverRl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    
    try {
        const message = JSON.parse(line);
        
        // Match response to pending request using the 'id'
        if (message.id !== undefined && pendingRequests.has(message.id)) {
            const { resolve, reject } = pendingRequests.get(message.id);
            pendingRequests.delete(message.id);
            
            if (message.error) {
                reject(new Error(message.error.message || JSON.stringify(message.error)));
            } else {
                resolve(message.result);
            }
        } else {
            console.log(`[Client] Received notification/unhandled message from server:`, message);
        }
    } catch (err) {
        console.error(`[Client] Error parsing message from server: ${err.message}. Raw: ${line}`);
    }
});

// Sends a JSON-RPC request and returns a Promise resolving to the result
function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextRequestId++;
        const request = {
            jsonrpc: "2.0",
            id,
            method,
            params
        };
        pendingRequests.set(id, { resolve, reject });
        serverProcess.stdin.write(JSON.stringify(request) + '\n');
    });
}

// Sends a JSON-RPC notification (no response expected)
function sendNotification(method, params = {}) {
    const notification = {
        jsonrpc: "2.0",
        method,
        params
    };
    serverProcess.stdin.write(JSON.stringify(notification) + '\n');
}

// Helper to call a tool on the MCP server
async function callMcpTool(name, args) {
    const result = await sendRequest("tools/call", {
        name,
        arguments: args
    });
    if (result && result.content && result.content[0] && result.content[0].type === 'text') {
        return result.content[0].text;
    }
    return JSON.stringify(result);
}

// Perform client-server handshake
async function runHandshake() {
    console.log("[Client] Sending 'initialize' request to MCP server...");
    const initResult = await sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
            name: "system-media-control-client",
            version: "1.0.0"
        }
    });
    console.log(`[Client] Connection initialized. Server name: ${initResult.serverInfo.name}, version: ${initResult.serverInfo.version}`);

    console.log("[Client] Sending 'notifications/initialized' notification...");
    sendNotification("notifications/initialized");

    console.log("[Client] Requesting tool list...");
    const toolsResult = await sendRequest("tools/list");
    return toolsResult.tools || [];
}

// Handles integration with Gemini API
async function runGemini(apiKey, query, mcpTools) {
    console.log("[Client] Initializing Gemini client...");
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Map MCP Tools to Gemini Function Declarations
    const functionDeclarations = mcpTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
    }));

    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        tools: [{ functionDeclarations }]
    });

    const chat = model.startChat();
    console.log(`[Client] Sending prompt to Gemini: "${query}"`);
    let result = await chat.sendMessage(query);
    let response = result.response;
    
    // Process function call loop in case Gemini decides to run tools sequentially
    let calls = response.functionCalls();
    while (calls && calls.length > 0) {
        const functionResponses = [];
        
        for (const call of calls) {
            console.log(`\n[Client] [Gemini Tool Call] Gemini requested tool: ${call.name}`);
            console.log(`[Client] Arguments:`, JSON.stringify(call.args));
            
            try {
                // Call the MCP Server
                const toolOutput = await callMcpTool(call.name, call.args);
                console.log(`[Client] MCP Server output: "${toolOutput.replace(/\n/g, ' ')}"`);
                
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: { result: toolOutput }
                    }
                });
            } catch (err) {
                console.error(`[Client] Error calling MCP tool: ${err.message}`);
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: { error: err.message }
                    }
                });
            }
        }
        
        console.log(`[Client] Feeding tool results back to Gemini...`);
        result = await chat.sendMessage(functionResponses);
        response = result.response;
        calls = response.functionCalls();
    }
    
    console.log(`\n[Client] Gemini Final Response:\n=================================\n${response.text()}\n=================================`);
}

// Handles integration with OpenAI API
async function runOpenAI(apiKey, query, mcpTools) {
    console.log("[Client] Initializing OpenAI client...");
    const openai = new OpenAI({ apiKey });
    
    // Map MCP Tools to OpenAI tools schema
    const tools = mcpTools.map(tool => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
        }
    }));

    const messages = [
        { role: "user", content: query }
    ];

    let running = true;
    while (running) {
        console.log(`[Client] Sending request to OpenAI...`);
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages,
            tools
        });

        const choice = response.choices[0];
        const message = choice.message;
        messages.push(message);

        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                const name = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                
                console.log(`\n[Client] [OpenAI Tool Call] OpenAI requested tool: ${name}`);
                console.log(`[Client] Arguments:`, JSON.stringify(args));
                
                try {
                    const toolOutput = await callMcpTool(name, args);
                    console.log(`[Client] MCP Server output: "${toolOutput.replace(/\n/g, ' ')}"`);
                    
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: name,
                        content: toolOutput
                    });
                } catch (err) {
                    console.error(`[Client] Error calling MCP tool: ${err.message}`);
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: name,
                        content: `Error: ${err.message}`
                    });
                }
            }
        } else {
            console.log(`\n[Client] OpenAI Final Response:\n=================================\n${message.content}\n=================================`);
            running = false;
        }
    }
}

// Handles mock AI execution when no API keys are present (useful for offline testing)
async function runMockAI(query, mcpTools) {
    console.log(`\n[Client] [Mock Mode] No API keys configured. Running in Mock AI Mode.`);
    console.log(`[Client] [Mock Mode] Analyzing query: "${query}"`);
    
    let toolName = null;
    let toolArgs = {};
    const lowerQuery = query.toLowerCase();
    
    if (lowerQuery.includes('lautstärke') || lowerQuery.includes('volume') || lowerQuery.includes('laut') || lowerQuery.includes('leise')) {
        const match = lowerQuery.match(/(\d+)/);
        if (match) {
            toolName = 'set_volume';
            toolArgs = { level: Number(match[1]) };
        } else {
            toolName = 'get_volume';
        }
    } else if (lowerQuery.includes('stumm') || lowerQuery.includes('mute')) {
        toolName = 'set_mute';
        toolArgs = { mute: !lowerQuery.includes('unmute') && !lowerQuery.includes('lauter') };
    } else if (lowerQuery.includes('paus') || lowerQuery.includes('play') || lowerQuery.includes('musik') || lowerQuery.includes('stopp')) {
        toolName = 'media_control';
        toolArgs = { action: 'play_pause' };
    } else if (lowerQuery.includes('weiter') || lowerQuery.includes('next') || lowerQuery.includes('nächst')) {
        toolName = 'media_control';
        toolArgs = { action: 'next_track' };
    } else if (lowerQuery.includes('zurück') || lowerQuery.includes('prev')) {
        toolName = 'media_control';
        toolArgs = { action: 'prev_track' };
    } else if (lowerQuery.includes('ausgelastet') || lowerQuery.includes('status') || lowerQuery.includes('system') || lowerQuery.includes('pc')) {
        toolName = 'get_system_status';
    }
    
    if (toolName) {
        console.log(`\n[Client] [Mock Tool Call] Mock AI requested tool: ${toolName}`);
        console.log(`[Client] Arguments:`, JSON.stringify(toolArgs));
        
        try {
            const toolOutput = await callMcpTool(toolName, toolArgs);
            console.log(`[Client] MCP Server output: "${toolOutput.replace(/\n/g, ' ')}"`);
            
            console.log(`\n[Client] Mock AI Final Response:\n=================================\n[Mock AI] Hier ist das Ergebnis der Aktion: ${toolOutput}\n=================================`);
        } catch (err) {
            console.error(`[Client] Error calling MCP tool: ${err.message}`);
        }
    } else {
        console.log(`\n[Client] Mock AI Final Response:\n=================================\n[Mock AI] Ich habe deine Anfrage verstanden: "${query}". Ich benötige dafür kein Tool.\n=================================`);
    }
}

// Main client entrypoint
async function main() {
    try {
        // Step 1: Handshake with MCP Server to fetch tools list
        const mcpTools = await runHandshake();
        console.log(`[Client] Discovered ${mcpTools.length} tools from server:`, mcpTools.map(t => t.name).join(', '));
        
        // Step 2: Get user query (either command-line argument or interactive console prompt)
        let query = process.argv.slice(2).join(' ').trim();
        
        if (!query) {
            console.log('\n[Client] No prompt provided via command line args. Entering interactive prompt...');
            const rlInterface = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            query = await new Promise((resolve) => {
                rlInterface.question('\nEnter your request (e.g. "Wie ausgelastet ist mein PC?" or "Mute the volume"): ', (answer) => {
                    rlInterface.close();
                    resolve(answer.trim());
                });
            });
        }
        
        if (!query) {
            console.log("[Client] Empty query. Exiting.");
            serverProcess.kill();
            process.exit(0);
        }
        
        // Step 3: Choose API provider based on env variables
        const geminiKey = process.env.GEMINI_API_KEY;
        const openAIKey = process.env.OPENAI_API_KEY;
        
        if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
            await runGemini(geminiKey, query, mcpTools);
        } else if (openAIKey && openAIKey !== 'your_openai_api_key_here') {
            await runOpenAI(openAIKey, query, mcpTools);
        } else {
            // Fallback to Mock AI Mode for testing
            await runMockAI(query, mcpTools);
        }
        
    } catch (err) {
        console.error(`[Client] Fatal Error in Client execution: ${err.message}`, err);
    } finally {
        console.log("\n[Client] Shutting down MCP Server background process...");
        serverProcess.kill();
        process.exit(0);
    }
}

main();
