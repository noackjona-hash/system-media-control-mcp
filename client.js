require('dotenv').config();
const { spawn } = require('child_process');
const readline = require('readline');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// Path to the MCP Server
const SERVER_PATH = './server.js';

// ANSI Console Colors
const COLORS = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m"
};

// Logging helpers
function logInfo(msg) {
    console.log(`${COLORS.green}${COLORS.bright}[Client]${COLORS.reset} ${msg}`);
}
function logStep(msg) {
    console.log(`${COLORS.yellow}${COLORS.bright}[Step]${COLORS.reset} ${msg}`);
}
function logTool(msg) {
    console.log(`${COLORS.cyan}${COLORS.bright}[Tool Call]${COLORS.reset} ${msg}`);
}
function logError(msg) {
    console.error(`${COLORS.red}${COLORS.bright}[Error]${COLORS.reset} ${msg}`);
}
function logServer(msg) {
    console.error(`${COLORS.magenta}[Server Log]${COLORS.reset} ${msg}`);
}

logInfo(`Starting MCP Server: node ${SERVER_PATH}...`);
const serverProcess = spawn('node', [SERVER_PATH]);

const serverRl = readline.createInterface({
    input: serverProcess.stdout,
    terminal: false
});

serverProcess.stderr.on('data', (data) => {
    logServer(data.toString().trim());
});

serverProcess.on('exit', (code) => {
    logInfo(`MCP Server process exited with code ${code}`);
    process.exit(code);
});

// JSON-RPC state
let nextRequestId = 1;
const pendingRequests = new Map();

serverRl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    
    try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pendingRequests.has(message.id)) {
            const { resolve, reject } = pendingRequests.get(message.id);
            pendingRequests.delete(message.id);
            
            if (message.error) {
                reject(new Error(message.error.message || JSON.stringify(message.error)));
            } else {
                resolve(message.result);
            }
        }
    } catch (err) {
        logError(`Error parsing server message: ${err.message}. Raw: ${line}`);
    }
});

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

function sendNotification(method, params = {}) {
    const notification = {
        jsonrpc: "2.0",
        method,
        params
    };
    serverProcess.stdin.write(JSON.stringify(notification) + '\n');
}

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

async function runHandshake() {
    logStep("Sending 'initialize' request to MCP server...");
    const initResult = await sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
            name: "system-media-control-client",
            version: "1.0.0"
        }
    });
    logInfo(`Connection initialized. Server: ${initResult.serverInfo.name} (${initResult.serverInfo.version})`);

    logStep("Sending 'notifications/initialized' notification...");
    sendNotification("notifications/initialized");

    logStep("Requesting tool list...");
    const toolsResult = await sendRequest("tools/list");
    return toolsResult.tools || [];
}

async function runGemini(apiKey, query, mcpTools) {
    const genAI = new GoogleGenerativeAI(apiKey);
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
    logInfo(`Sending prompt to Gemini: "${query}"`);
    let result = await chat.sendMessage(query);
    let response = result.response;
    
    let calls = response.functionCalls();
    while (calls && calls.length > 0) {
        const functionResponses = [];
        
        for (const call of calls) {
            logTool(`Gemini requested: ${COLORS.bright}${call.name}${COLORS.reset} with args: ${JSON.stringify(call.args)}`);
            try {
                const toolOutput = await callMcpTool(call.name, call.args);
                logInfo(`MCP Server responded: "${toolOutput.replace(/\n/g, ' ')}"`);
                
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: { result: toolOutput }
                    }
                });
            } catch (err) {
                logError(`MCP execution failed: ${err.message}`);
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: { error: err.message }
                    }
                });
            }
        }
        
        logStep(`Feeding tool results back to Gemini...`);
        result = await chat.sendMessage(functionResponses);
        response = result.response;
        calls = response.functionCalls();
    }
    
    console.log(`\n${COLORS.green}${COLORS.bright}Gemini Final Response:${COLORS.reset}\n=================================\n${response.text()}\n=================================`);
}

async function runOpenAI(apiKey, query, mcpTools) {
    const openai = new OpenAI({ apiKey });
    const tools = mcpTools.map(tool => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
        }
    }));

    const messages = [{ role: "user", content: query }];
    let running = true;
    
    while (running) {
        logStep(`Sending request to OpenAI...`);
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
                
                logTool(`OpenAI requested: ${COLORS.bright}${name}${COLORS.reset} with args: ${JSON.stringify(args)}`);
                try {
                    const toolOutput = await callMcpTool(name, args);
                    logInfo(`MCP Server responded: "${toolOutput.replace(/\n/g, ' ')}"`);
                    
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: name,
                        content: toolOutput
                    });
                } catch (err) {
                    logError(`MCP execution failed: ${err.message}`);
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: name,
                        content: `Error: ${err.message}`
                    });
                }
            }
        } else {
            console.log(`\n${COLORS.green}${COLORS.bright}OpenAI Final Response:${COLORS.reset}\n=================================\n${message.content}\n=================================`);
            running = false;
        }
    }
}

async function runMockAI(query, mcpTools) {
    logInfo(`[Mock Mode] No API keys configured. Running locally.`);
    
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
    } else if (lowerQuery.includes('prozess') || lowerQuery.includes('task') || lowerQuery.includes('cpu consuming') || lowerQuery.includes('auslastung')) {
        toolName = 'get_top_processes';
    } else if (lowerQuery.includes('akku') || lowerQuery.includes('battery') || lowerQuery.includes('lade')) {
        toolName = 'get_battery_status';
    } else if (lowerQuery.includes('helligkeit') || lowerQuery.includes('brightness')) {
        const match = lowerQuery.match(/(\d+)/);
        if (match) {
            toolName = 'set_brightness';
            toolArgs = { level: Number(match[1]) };
        } else {
            toolName = 'get_brightness';
        }
    } else if (lowerQuery.includes('sperr') || lowerQuery.includes('lock')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'lock' };
    } else if (lowerQuery.includes('sleep') || lowerQuery.includes('ruhezustand')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'sleep' };
    } else if (lowerQuery.includes('herunterfahren') || lowerQuery.includes('shutdown')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'shutdown' };
    } else if (lowerQuery.includes('neustart') || lowerQuery.includes('restart')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'restart' };
    } else if (lowerQuery.includes('abbrechen') || lowerQuery.includes('abort')) {
        toolName = 'system_power_control';
        toolArgs = { action: 'abort_shutdown' };
    } else if (lowerQuery.includes('ausgelastet') || lowerQuery.includes('status') || lowerQuery.includes('system') || lowerQuery.includes('pc')) {
        toolName = 'get_system_status';
    }
    
    if (toolName) {
        logTool(`Mock AI requested: ${COLORS.bright}${toolName}${COLORS.reset} with args: ${JSON.stringify(toolArgs)}`);
        try {
            const toolOutput = await callMcpTool(toolName, toolArgs);
            console.log(`\n${COLORS.green}${COLORS.bright}Mock AI Final Response:${COLORS.reset}\n=================================\n${toolOutput}\n=================================`);
        } catch (err) {
            logError(`Mock execution failed: ${err.message}`);
        }
    } else {
        console.log(`\n${COLORS.green}${COLORS.bright}Mock AI Final Response:${COLORS.reset}\n=================================\n[Mock AI] I understood: "${query}". No tools required.\n=================================`);
    }
}

async function main() {
    try {
        const mcpTools = await runHandshake();
        logInfo(`Discovered ${mcpTools.length} tools from server: ${mcpTools.map(t => t.name).join(', ')}`);
        
        const geminiKey = process.env.GEMINI_API_KEY;
        const openAIKey = process.env.OPENAI_API_KEY;
        
        let query = process.argv.slice(2).join(' ').trim();
        
        if (query) {
            // Single-shot run mode via CLI args
            if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
                await runGemini(geminiKey, query, mcpTools);
            } else if (openAIKey && openAIKey !== 'your_openai_api_key_here') {
                await runOpenAI(openAIKey, query, mcpTools);
            } else {
                await runMockAI(query, mcpTools);
            }
        } else {
            // Interactive persistent loop
            console.log(`\n${COLORS.yellow}${COLORS.bright}--- PC Agent Interactive Prompt Mode ---${COLORS.reset}`);
            console.log(`Type queries in natural language (e.g. "Wie ausgelastet ist mein PC?" or "Mute").`);
            console.log(`Type ${COLORS.bright}'exit'${COLORS.reset} or ${COLORS.bright}'q'${COLORS.reset} to quit.\n`);
            
            const userRl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            while (true) {
                const answer = await new Promise((resolve) => {
                    userRl.question(`${COLORS.bright}${COLORS.white}Ask Agent > ${COLORS.reset}`, resolve);
                });
                const trimmed = answer.trim();
                
                if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'q' || trimmed.toLowerCase() === 'quit') {
                    break;
                }
                if (!trimmed) continue;
                
                try {
                    if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
                        await runGemini(geminiKey, trimmed, mcpTools);
                    } else if (openAIKey && openAIKey !== 'your_openai_api_key_here') {
                        await runOpenAI(openAIKey, trimmed, mcpTools);
                    } else {
                        await runMockAI(trimmed, mcpTools);
                    }
                } catch (e) {
                    logError(`Failed to process request: ${e.message}`);
                }
                console.log(); // empty spacing line
            }
            userRl.close();
        }
    } catch (err) {
        logError(`Fatal Error in client execution: ${err.message}`);
    } finally {
        logInfo("Shutting down MCP Server background process...");
        serverProcess.kill();
        process.exit(0);
    }
}

main();
