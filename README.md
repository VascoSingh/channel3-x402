# Channel3 x402 Wrapper

Access [Channel3's](https://trychannel3.com) 100M+ product database through x402 micropayments.

## Why This Exists

Channel3 is building the product data layer for agentic commerce. But their current API requires traditional signup flows. This wrapper adds x402 payment support, enabling any AI agent to search products and pay per-call with USDC on Base—no API keys needed.

## Endpoints

| Endpoint | Price | Description |
|----------|-------|-------------|
| `POST /v1/search` | $0.01 | Search products by text or image |
| `GET /v1/lookup` | $0.005 | Get product details by URL |

## Usage with AgentCash

```bash
# Search for products
npx agentcash fetch https://your-deployment.onrender.com/v1/search \
  -m POST \
  -b '{"query": "wireless earbuds", "limit": 5}'
```

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CHANNEL3_API_KEY` | API key from [Channel3](https://trychannel3.com) |
| `WALLET_ADDRESS` | Your wallet address for receiving payments |
| `CDP_API_KEY_ID` | (Optional) Coinbase CDP key for payment verification |
| `CDP_API_KEY_SECRET` | (Optional) Coinbase CDP secret |

## Local Development

```bash
cp .env.example .env
# Edit .env with your keys
npm install
npm run dev
```

## How It Works

1. Client requests `/v1/search` without payment
2. Server returns `402 Payment Required` with x402 payment details
3. Client signs USDC payment on Base
4. Client retries with `X-Payment` header
5. Server verifies payment and returns Channel3 results

## License

MIT
