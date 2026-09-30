from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import yfinance as yf
from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading FinBERT model...")
tokenizer = AutoTokenizer.from_pretrained("ProsusAI/finbert")
model = AutoModelForSequenceClassification.from_pretrained("ProsusAI/finbert")
labels = ["positive", "negative", "neutral"]
print("Model loaded successfully!")

def analyze_sentiment(text):
    inputs = tokenizer(text, return_tensors="pt", padding=True, truncation=True)
    with torch.no_grad():
        outputs = model(**inputs)
    probabilities = torch.nn.functional.softmax(outputs.logits, dim=-1)
    sentiment_idx = torch.argmax(probabilities).item()
    confidence = probabilities[0][sentiment_idx].item()
    return labels[sentiment_idx], confidence

import requests
from bs4 import BeautifulSoup
import re

def scrape_article_text(url):
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        res = requests.get(url, headers=headers, timeout=5)
        soup = BeautifulSoup(res.text, 'html.parser')
        paragraphs = soup.find_all('p')
        text = ' '.join([p.get_text() for p in paragraphs])
        # Return first 500 characters to stay within BERT token limits
        return text[:500] if text else None
    except:
        return None

def fetch_reddit_sentiment(ticker):
    try:
        headers = {'User-Agent': 'FinSentBot/1.0'}
        # Search WSB for the ticker
        url = f"https://www.reddit.com/r/wallstreetbets/search.json?q={ticker}&restrict_sr=on&sort=new&t=week"
        res = requests.get(url, headers=headers, timeout=5)
        data = res.json()
        
        posts = data.get('data', {}).get('children', [])
        if not posts: return {"status": "neutral", "mentions": 0}
        
        pos = 0
        neg = 0
        for post in posts[:5]: # Analyze top 5 recent posts
            title = post['data']['title']
            sent, _ = analyze_sentiment(title)
            if sent == "positive": pos += 1
            if sent == "negative": neg += 1
            
        overall = "neutral"
        if pos > neg: overall = "positive"
        elif neg > pos: overall = "negative"
        
        return {"status": overall, "mentions": len(posts)}
    except:
        return {"status": "neutral", "mentions": 0}

import os
def get_llm_highlight(text):
    if not text: return None
    # Use environment variable for API key
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5500",
        "X-Title": "FinSent"
    }
    data = {
        "model": "google/gemma-4-26b-a4b-it:free", # Google Gemma 4 26B model requested by user
        "messages": [
            {"role": "user", "content": f"Extract the single most important, impactful sentence from the following financial text that drives its sentiment. Return ONLY that sentence and nothing else. No intro, no quotes, no conversational text.\n\nText: {text[:1500]}"}
        ]
    }
    try:
        res = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=data, timeout=8)
        if res.status_code != 200:
            return f"API Error: {res.status_code} - {res.text[:100]}"
        return res.json()['choices'][0]['message']['content'].strip()
    except Exception as e:
        return f"Failed to generate highlight: {str(e)}"

@app.get("/api/sentiment")
def get_sentiment(ticker: str):
    try:
        stock = yf.Ticker(ticker)
        news_items = stock.news
        
        if not news_items:
            return {"ticker": ticker, "error": "No news found for this ticker."}
            
        # Sort news from newest to oldest based on pubDate
        try:
            news_items = sorted(news_items, key=lambda x: x.get('content', {}).get('pubDate', ''), reverse=True)
        except Exception:
            pass # Fallback to original order if sorting fails

        results = []
        positive_count = 0
        negative_count = 0
        neutral_count = 0
        
        all_related_orgs = set()

        for item in news_items[:10]:
            content = item.get('content', {})
            title = content.get('title', '')
            link = content.get('canonicalUrl', {}).get('url', '')
            publisher = content.get('provider', {}).get('displayName', '')
            pub_date = content.get('pubDate', '')

            if title:
                # Feature 1: Web Scraping for Full Text
                full_text = scrape_article_text(link) or content.get('summary', '') or title
                sentiment, confidence = analyze_sentiment(full_text)
                
                # Highlight Extraction using OpenRouter
                ai_highlight = get_llm_highlight(full_text)
                
                # Feature 2 (NER) skipped due to system DLL restrictions
                all_related_orgs.add("NER Disabled (System Policy)")

                results.append({
                    "title": title,
                    "link": link,
                    "publisher": publisher,
                    "pubDate": pub_date,
                    "sentiment": sentiment,
                    "confidence": confidence,
                    "highlight": ai_highlight
                })
                
                if sentiment == "positive":
                    positive_count += 1
                elif sentiment == "negative":
                    negative_count += 1
                else:
                    neutral_count += 1

        total = len(results)
        overall_sentiment = "neutral"
        volatility_warning = False

        if total > 0:
            if positive_count > negative_count and positive_count >= neutral_count:
                overall_sentiment = "positive"
            elif negative_count > positive_count and negative_count >= neutral_count:
                overall_sentiment = "negative"
            
            # Feature 3: Extreme Event Alerts (Volatility Warning)
            if (negative_count / total) >= 0.6:
                volatility_warning = True

        # Feature 4: Social Sentiment
        reddit_data = fetch_reddit_sentiment(ticker)

        return {
            "ticker": ticker.upper(),
            "overall_sentiment": overall_sentiment,
            "volatility_warning": volatility_warning,
            "reddit_sentiment": reddit_data,
            "related_entities": list(all_related_orgs)[:8], # Top 8 organizations
            "stats": {
                "total": total,
                "positive": positive_count,
                "negative": negative_count,
                "neutral": neutral_count
            },
            "news": results
        }
    except Exception as e:
        return {"error": str(e)}

import json

@app.get("/api/details")
def get_details(ticker: str):
    try:
        stock = yf.Ticker(ticker)
        
        # 1. Technicals & History (1 year for SMA 200)
        hist = stock.history(period="1y")
        if hist.empty:
            return {"error": "No historical data found."}
            
        # Calculate moving averages
        hist['SMA50'] = hist['Close'].rolling(window=50).mean()
        hist['SMA200'] = hist['Close'].rolling(window=200).mean()
        
        # Take last 30 days for chart display
        hist_30 = hist.tail(30)
        
        dates = hist_30.index.strftime('%Y-%m-%d').tolist()
        prices = hist_30['Close'].round(2).tolist()
        volumes = hist_30['Volume'].tolist()
        
        # Replace NaNs with None for JSON serialization
        sma50 = [round(x, 2) if not (x != x) else None for x in hist_30['SMA50']]
        sma200 = [round(x, 2) if not (x != x) else None for x in hist_30['SMA200']]
        
        current_price = prices[-1]
        c_sma50 = hist['SMA50'].iloc[-1]
        c_sma200 = hist['SMA200'].iloc[-1]
        
        if c_sma50 != c_sma50 or c_sma200 != c_sma200: # Check NaN
            trend = "Neutral"
        elif current_price > c_sma50 and c_sma50 > c_sma200:
            trend = "Bullish"
        elif current_price < c_sma50 and c_sma50 < c_sma200:
            trend = "Bearish"
        else:
            trend = "Neutral"
        
        # 2. Fundamentals
        info = stock.info
        fundamentals = {
            "marketCap": info.get("marketCap", "N/A"),
            "trailingPE": round(info.get("trailingPE", 0), 2) if info.get("trailingPE") else "N/A",
            "priceToBook": round(info.get("priceToBook", 0), 2) if info.get("priceToBook") else "N/A",
            "debtToEquity": round(info.get("debtToEquity", 0), 2) if info.get("debtToEquity") else "N/A",
            "returnOnEquity": round(info.get("returnOnEquity", 0)*100, 2) if info.get("returnOnEquity") else "N/A",
            "recommendation": info.get("recommendationKey", "N/A").replace('_', ' ').title()
        }
        
        # 3. SWOT & Peers via LLM
        summary = info.get("longBusinessSummary", "")[:2000]
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "HTTP-Referer": "http://localhost:5500"}
        prompt = f"Analyze '{ticker}' based on this summary: {summary}. Return ONLY a raw JSON object (no markdown, no backticks) with keys: 'SWOT' (dict with 'Strengths', 'Weaknesses', 'Opportunities', 'Threats' - lists of 2 strings each) and 'peers' (list of 3 competitor stock tickers)."
        data = {
            "model": "google/gemma-4-26b-a4b-it:free",
            "messages": [{"role": "user", "content": prompt}]
        }
        
        swot_data = {}
        peers_list = []
        try:
            res = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=data, timeout=12)
            res_content = res.json()['choices'][0]['message']['content'].strip()
            if res_content.startswith("```json"): res_content = res_content[7:]
            if res_content.startswith("```"): res_content = res_content[3:]
            if res_content.endswith("```"): res_content = res_content[:-3]
            
            parsed = json.loads(res_content.strip())
            swot_data = parsed.get("SWOT", {})
            peers_list = parsed.get("peers", [])
        except:
            swot_data = {"Strengths": ["Data unavailable"], "Weaknesses": ["Data unavailable"], "Opportunities": ["Data unavailable"], "Threats": ["Data unavailable"]}
        
        # 4. Peer Data Fetch
        peer_data = []
        for p in peers_list[:3]:
            try:
                p_info = yf.Ticker(p).info
                peer_data.append({
                    "ticker": p,
                    "marketCap": p_info.get("marketCap", "N/A"),
                    "pe": round(p_info.get("trailingPE", 0), 2) if p_info.get("trailingPE") else "N/A",
                    "revenue": p_info.get("totalRevenue", "N/A")
                })
            except:
                pass

        return {
            "dates": dates,
            "prices": prices,
            "volumes": volumes,
            "sma50": sma50,
            "sma200": sma200,
            "trend": trend,
            "fundamentals": fundamentals,
            "swot": swot_data,
            "peers": peer_data
        }
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/sidebar")
def get_sidebar_data():
    try:
        # 1. Market Indices
        indices = yf.Tickers("^GSPC ^IXIC ^VIX BTC-USD")
        indices_data = []
        for symbol, ticker in indices.tickers.items():
            try:
                info = ticker.fast_info
                change = ((info.last_price - info.previous_close) / info.previous_close) * 100
                name_map = {"^GSPC": "S&P 500", "^IXIC": "NASDAQ", "^VIX": "VIX", "BTC-USD": "Bitcoin"}
                indices_data.append({
                    "name": name_map.get(symbol, symbol),
                    "price": round(info.last_price, 2),
                    "change": round(change, 2)
                })
            except: pass

        # 2. Trending / Most Active (Popular proxies)
        trending = yf.Tickers("NVDA TSLA AAPL AMD META")
        trending_data = []
        for symbol, ticker in trending.tickers.items():
            try:
                info = ticker.fast_info
                change = ((info.last_price - info.previous_close) / info.previous_close) * 100
                trending_data.append({
                    "symbol": symbol,
                    "price": round(info.last_price, 2),
                    "change": round(change, 2)
                })
            except: pass

        # 3. Sectors (ETFs proxy)
        sectors = yf.Tickers("XLK XLV XLE XLF")
        sector_data = []
        for symbol, ticker in sectors.tickers.items():
            try:
                info = ticker.fast_info
                change = ((info.last_price - info.previous_close) / info.previous_close) * 100
                name_map = {"XLK": "Tech", "XLV": "Health", "XLE": "Energy", "XLF": "Finance"}
                sector_data.append({
                    "name": name_map.get(symbol, symbol),
                    "change": round(change, 2)
                })
            except: pass

        return {
            "indices": indices_data,
            "trending": trending_data,
            "sectors": sector_data
        }
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
