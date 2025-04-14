#!/usr/bin/env node
import { EventSource } from "eventsource";
import { Buffer } from 'buffer';
import { argv, exit, stdin } from 'process';

// -- Configuration ----------------------------------

interface ConfigOption {
  cliFlag: string;
  default?: string;
  description: string;
  isArray?: boolean;
}

const CONFIG_OPTIONS: Record<string, ConfigOption> = {
  baseUrl: {
    cliFlag: '--url',
    default: 'http://localhost:4000',
    description: 'Base URL for the MCP server'
  },
  header: {
    cliFlag: '--header',
    description: 'Add HTTP header (format: "Name: Value")',
    isArray: true
  }
};

interface Config {
  baseUrl: string;
  headers: Record<string, string>;
}

function parseConfig(): Config {
  // Parse all CLI args into a map
  const cliArgs = new Map<string, string[]>();
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (value) {
        const values = cliArgs.get(key) || [];
        values.push(value);
        cliArgs.set(key, values);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        const values = cliArgs.get(key) || [];
        values.push(argv[++i]);
        cliArgs.set(key, values);
      }
    }
  }

  // Parse headers from CLI arguments
  const headers: Record<string, string> = {};
  const headerArgs = cliArgs.get('header') || [];

  headerArgs.forEach(header => {
    const [name, ...valueParts] = header.split(':');
    const value = valueParts.join(':').trim();
    if (name && value) {
      headers[name.trim()] = value;
    }
  });

  // Get base URL from CLI args or default
  const urlValues = cliArgs.get('url');
  let baseUrl = urlValues?.[0] ?? CONFIG_OPTIONS.baseUrl.default ?? '';
  if (!baseUrl.startsWith('http')) {
    baseUrl = `http://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/$/, '');

  return { baseUrl, headers };
}

// Initialize configuration
const config = parseConfig();
const sseUrl = `${config.baseUrl}/sse`;
let messagePostUrl = `${config.baseUrl}/message`;

const debug = console.error; // Debug output to stderr
const sendToClaude = console.log; // Output to Claude via stdout

// -- Connect to MCP SSE Server ----------------------

function initializeSSEConnection(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("❌ SSE connection timeout")), 10_000);
    const source = new EventSource(sseUrl);

    source.onopen = () => {
      clearTimeout(timeout);
      debug("✅ Connected to SSE backend");
      resolve();
    };

    source.addEventListener("endpoint", (e) => {
      const url = new URL(config.baseUrl);
      messagePostUrl = `${url.protocol}//${url.host}${e.data}`;
      debug(`📡 Updated message POST endpoint → ${messagePostUrl}`);
    });

    source.addEventListener("message", (e) => {
      sendToClaude(e.data); // Forward to Claude
      debug(`<-- ${e.data}`);
    });

    source.onerror = (e) => reject(e);
  });
}

// -- Forward STDIN Messages to Backend --------------

async function forwardStdioMessage(buffer: Buffer) {
  const payload = buffer.toString().trim();
  debug("-->", payload);

  try {
    const response = await fetch(messagePostUrl, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json',
        ...config.headers
      },
      body: payload
    });

    if (!response.ok) {
      debug(`❌ HTTP ${response.status}: ${response.statusText}`);
    }
  } catch (err) {
    debug("❌ Failed to POST message:", err);
  }
}

// -- Start the STDIO Bridge -------------------------

async function startBridge() {
  debug(`🌉 Launching MCP Bridge → ${config.baseUrl}`);
  debug(`📝 Using headers:`, config.headers);

  try {
    await initializeSSEConnection();

    stdin.on("data", forwardStdioMessage);
    stdin.on("end", () => {
      debug("⛔ STDIN closed. Exiting...");
      exit(0);
    });

    debug("🚀 MCP Bridge running. Listening via STDIO...");
  } catch (err) {
    debug("❌ Bridge initialization failed:", err);
    exit(1);
  }
}

startBridge();
