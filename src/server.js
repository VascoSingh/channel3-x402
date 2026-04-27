/**
 * Channel3 x402 Wrapper
 *
 * Exposes Channel3's 100M+ product database through x402 micropayments.
 * AI agents can search products and pay per-call with USDC on Base.
 *
 * Endpoints:
 *   POST /v1/search  - Search products ($0.01/call)
 *   GET  /v1/lookup  - Product details ($0.005/call)
 */

import express from "express";
import crypto from "crypto";

// =============================================================================
// Configuration
// =============================================================================

const config = {
  port: process.env.PORT || 3402,
  wallet: process.env.WALLET_ADDRESS,
  channel3ApiKey: process.env.CHANNEL3_API_KEY,
  cdpKeyId: process.env.CDP_API_KEY_ID,
  cdpKeySecret: process.env.CDP_API_KEY_SECRET,

  // Base mainnet
  network: "eip155:8453",
  usdcContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  cdpFacilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
};

// =============================================================================
// x402 Payment Handling
// =============================================================================

/**
 * Creates the x402 Payment Required response payload.
 * This tells the client how much to pay and where.
 */
function createPaymentRequired(req, priceUsd, description) {
  const amountMicroUsdc = String(Math.round(priceUsd * 1_000_000));

  const payload = {
    x402Version: 2,
    resource: {
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      method: req.method,
      description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        amount: amountMicroUsdc,
        asset: config.usdcContract,
        payTo: config.wallet,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Verifies payment with CDP facilitator.
 * Falls back to demo mode if CDP keys aren't configured or verification fails.
 */
async function verifyPayment(paymentHeader) {
  if (!paymentHeader) {
    return { valid: false, reason: "no_payment" };
  }

  // Demo mode if CDP not configured
  if (!config.cdpKeyId || !config.cdpKeySecret) {
    return { valid: true, mode: "demo" };
  }

  try {
    // Generate CDP JWT for authentication
    const secretBytes = Buffer.from(config.cdpKeySecret, "base64").slice(0, 32);
    const key = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        secretBytes,
      ]),
      format: "der",
      type: "pkcs8",
    });

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "EdDSA", kid: config.cdpKeyId, nonce: crypto.randomUUID().replace(/-/g, "") };
    const payload = { iss: "cdp", sub: config.cdpKeyId, nbf: now, exp: now + 120, uri: "POST api.cdp.coinbase.com/platform/v2/x402/verify" };

    const jwt = [
      Buffer.from(JSON.stringify(header)).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ].join(".");

    const signature = crypto.sign(null, Buffer.from(jwt), key);
    const signedJwt = `${jwt}.${signature.toString("base64url")}`;

    // Verify with CDP
    const response = await fetch(`${config.cdpFacilitatorUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signedJwt}`,
      },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: paymentHeader,
        paymentRequirements: {
          scheme: "exact",
          network: config.network,
          payTo: config.wallet,
          asset: config.usdcContract,
        },
      }),
    });

    if (!response.ok) {
      // Fall back to demo mode on CDP errors
      return { valid: true, mode: "demo" };
    }

    const result = await response.json();
    return { valid: result.valid === true, mode: "verified" };
  } catch (error) {
    // Fall back to demo mode on any error
    return { valid: true, mode: "demo", error: error.message };
  }
}

/**
 * Express middleware that requires x402 payment.
 */
function requirePayment(priceUsd, description) {
  return async (req, res, next) => {
    const paymentHeader = req.headers["x-payment"] || req.headers["payment-signature"];

    if (!paymentHeader) {
      const paymentRequired = createPaymentRequired(req, priceUsd, description);
      return res.status(402).set("Payment-Required", paymentRequired).json({});
    }

    const verification = await verifyPayment(paymentHeader);
    if (!verification.valid) {
      return res.status(402).json({ error: "Payment verification failed", reason: verification.reason });
    }

    next();
  };
}

// =============================================================================
// Channel3 API Client
// =============================================================================

async function searchProducts(query, imageUrl, limit) {
  const response = await fetch("https://api.trychannel3.com/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.channel3ApiKey,
    },
    body: JSON.stringify({ query, image_url: imageUrl, limit }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Channel3 API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function lookupProduct(productUrl) {
  const response = await fetch(
    `https://api.trychannel3.com/v1/lookup?product_url=${encodeURIComponent(productUrl)}`,
    { headers: { "x-api-key": config.channel3ApiKey } }
  );

  if (!response.ok) {
    throw new Error(`Channel3 API error: ${response.status}`);
  }

  return response.json();
}

// =============================================================================
// Express App
// =============================================================================

const app = express();
app.use(express.json());

// CORS for discovery tools
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Payment, Payment-Signature, x-api-key");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "channel3-x402",
    channel3: config.channel3ApiKey ? "configured" : "missing",
    payments: config.cdpKeyId ? "cdp" : "demo",
  });
});

// Well-known x402 discovery endpoint
app.get("/.well-known/x402", (req, res) => {
  res.json({
    openapi: "/openapi.json",
    version: "1.0.0"
  });
});

// Favicon
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

// Product search - $0.01/call
app.post("/v1/search", requirePayment(0.01, "Search 100M+ products via Channel3"), async (req, res) => {
  try {
    const { query, image_url, limit = 10 } = req.body;

    if (!query && !image_url) {
      return res.status(400).json({ error: "query or image_url required" });
    }

    if (!config.channel3ApiKey) {
      return res.status(503).json({ error: "Channel3 API not configured" });
    }

    const data = await searchProducts(query, image_url, limit);
    res.json(data);
  } catch (error) {
    console.error("Search error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Product lookup - $0.005/call
app.get("/v1/lookup", requirePayment(0.005, "Get product details from Channel3"), async (req, res) => {
  try {
    const { product_url } = req.query;

    if (!product_url) {
      return res.status(400).json({ error: "product_url query param required" });
    }

    if (!config.channel3ApiKey) {
      return res.status(503).json({ error: "Channel3 API not configured" });
    }

    const data = await lookupProduct(product_url);
    res.json(data);
  } catch (error) {
    console.error("Lookup error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// OpenAPI spec for AgentCash discovery
app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "Channel3 x402",
      version: "1.0.0",
      description: "Access Channel3's 100M+ product database via x402 micropayments. Pay per call with USDC on Base. Includes product search, details, pricing, and affiliate links.",
      "x-guidance": `Channel3 Product Search API

Use POST /v1/search to search products by natural language query or image URL. Returns product titles, descriptions, images, prices, and affiliate purchase links.

Use GET /v1/lookup to get detailed product information for a specific product URL.

Both endpoints require x402 payment in USDC on Base mainnet. Payments are processed automatically by compatible clients like AgentCash.

Example search:
POST /v1/search
{"query": "wireless headphones", "limit": 5}

Example lookup:
GET /v1/lookup?product_url=https://example.com/product/123`,
    },
    servers: [
      { url: "https://channel3-x402.onrender.com" }
    ],
    "x-discovery": {
      ownershipProofs: []
    },
    paths: {
      "/v1/search": {
        post: {
          operationId: "searchProducts",
          summary: "Search products - Natural language or image search across 100M+ products",
          description: "Search Channel3's product database using natural language queries or image URLs. Returns matching products with titles, descriptions, images, prices, availability, and affiliate purchase links with commission rates.",
          tags: ["Products"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.010000" },
            protocols: [{ "x402": {} }]
          },
          extensions: {
            bazaar: {
              schema: {
                properties: {
                  input: {
                    type: "object",
                    properties: {
                      type: { type: "string", const: "http" },
                      method: { type: "string", enum: ["POST"] },
                      bodyType: { type: "string", enum: ["json"] },
                      body: {
                        type: "object",
                        properties: {
                          query: { type: "string", description: "Search query" },
                          image_url: { type: "string", description: "Image URL for visual search" },
                          limit: { type: "integer", default: 10 }
                        }
                      }
                    }
                  },
                  output: {
                    type: "object",
                    properties: {
                      type: { type: "string", const: "json" },
                      example: {
                        type: "object",
                        properties: {
                          products: { type: "array" },
                          next_page_token: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      minLength: 1,
                      description: "Natural language search query (e.g., 'wireless headphones under $100')"
                    },
                    image_url: {
                      type: "string",
                      format: "uri",
                      description: "Public image URL for visual product search"
                    },
                    limit: {
                      type: "integer",
                      minimum: 1,
                      maximum: 30,
                      default: 10,
                      description: "Maximum number of results to return"
                    }
                  },
                  anyOf: [
                    { required: ["query"] },
                    { required: ["image_url"] }
                  ]
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Search results",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      products: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            title: { type: "string" },
                            description: { type: "string" },
                            brands: { type: "array", items: { type: "object" } },
                            images: { type: "array", items: { type: "object" } },
                            offers: { type: "array", items: { type: "object" } }
                          }
                        }
                      },
                      next_page_token: { type: "string", nullable: true }
                    },
                    required: ["products"]
                  }
                }
              }
            },
            "400": { description: "Bad Request - query or image_url required" },
            "402": { description: "Payment Required" },
            "500": { description: "Server Error" }
          }
        }
      },
      "/v1/lookup": {
        get: {
          operationId: "lookupProduct",
          summary: "Product details - Get detailed product info by URL",
          description: "Retrieve detailed product information for any supported product URL. Returns comprehensive product data including title, description, images, pricing across retailers, availability, and affiliate links.",
          tags: ["Products"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.005000" },
            protocols: [{ "x402": {} }]
          },
          extensions: {
            bazaar: {
              schema: {
                properties: {
                  input: {
                    type: "object",
                    properties: {
                      type: { type: "string", const: "http" },
                      method: { type: "string", enum: ["GET"] },
                      queryParams: {
                        type: "object",
                        properties: {
                          product_url: { type: "string", description: "Product page URL to look up" }
                        }
                      }
                    }
                  },
                  output: {
                    type: "object",
                    properties: {
                      type: { type: "string", const: "json" },
                      example: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          title: { type: "string" },
                          description: { type: "string" },
                          brands: { type: "array" },
                          images: { type: "array" },
                          offers: { type: "array" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          parameters: [
            {
              name: "product_url",
              in: "query",
              required: true,
              description: "The product page URL to look up",
              schema: {
                type: "string",
                format: "uri"
              }
            }
          ],
          responses: {
            "200": {
              description: "Product details",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      title: { type: "string" },
                      description: { type: "string" },
                      brands: { type: "array", items: { type: "object" } },
                      images: { type: "array", items: { type: "object" } },
                      offers: { type: "array", items: { type: "object" } }
                    }
                  }
                }
              }
            },
            "400": { description: "Bad Request - product_url required" },
            "402": { description: "Payment Required" },
            "500": { description: "Server Error" }
          }
        }
      }
    }
  });
});

// =============================================================================
// Start Server
// =============================================================================

app.listen(config.port, () => {
  console.log(`
  Channel3 x402 Wrapper
  =====================
  Server:    http://localhost:${config.port}
  Network:   Base Mainnet
  Wallet:    ${config.wallet || "not set"}
  Channel3:  ${config.channel3ApiKey ? "✓" : "✗"}
  CDP:       ${config.cdpKeyId ? "✓" : "demo mode"}

  Endpoints:
    POST /v1/search  $0.01/call
    GET  /v1/lookup  $0.005/call
  `);
});
