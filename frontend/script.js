document.addEventListener('DOMContentLoaded', () => {
    const analyzeBtn = document.getElementById('analyze-btn');
    const tickerInput = document.getElementById('ticker-input');
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error-message');
    const resultsSection = document.getElementById('results-section');
    
    // UI Elements
    const overallSentiment = document.getElementById('overall-sentiment');
    const statPos = document.getElementById('stat-pos');
    const statNeu = document.getElementById('stat-neu');
    const statNeg = document.getElementById('stat-neg');
    const newsList = document.getElementById('news-list');
    const watchlistEl = document.getElementById('watchlist');

    const API_URL = 'http://127.0.0.1:8000/api/sentiment';
    const DETAILS_API_URL = 'http://127.0.0.1:8000/api/details';

    const SIDEBAR_API_URL = 'http://127.0.0.1:8000/api/sidebar';

    let currentChart = null;

    // Theme Toggle Logic
    const themeToggleBtn = document.getElementById('theme-toggle');
    const themeIcon = themeToggleBtn.querySelector('i');
    
    // Check saved theme
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-mode');
        themeIcon.classList.remove('fa-moon');
        themeIcon.classList.add('fa-sun');
    }

    themeToggleBtn.addEventListener('click', () => {
        document.body.classList.toggle('light-mode');
        if (document.body.classList.contains('light-mode')) {
            localStorage.setItem('theme', 'light');
            themeIcon.classList.remove('fa-moon');
            themeIcon.classList.add('fa-sun');
        } else {
            localStorage.setItem('theme', 'dark');
            themeIcon.classList.remove('fa-sun');
            themeIcon.classList.add('fa-moon');
        }
        // Update Chart colors if it exists
        if(currentChart) {
            updateChartColors();
        }
    });

    function updateChartColors() {
        const isLight = document.body.classList.contains('light-mode');
        const textColor = isLight ? '#475569' : '#94a3b8';
        const gridColor = isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
        
        currentChart.options.scales.x.ticks.color = textColor;
        currentChart.options.scales.y.ticks.color = textColor;
        currentChart.options.scales.y.grid.color = gridColor;
        currentChart.options.plugins.legend.labels.color = textColor;
        
        const tooltipBg = isLight ? 'rgba(255,255,255,0.95)' : 'rgba(15, 23, 42, 0.9)';
        const tooltipTitle = isLight ? '#0f172a' : '#f8fafc';
        const tooltipBody = isLight ? '#334155' : '#cbd5e1';
        currentChart.options.plugins.tooltip.backgroundColor = tooltipBg;
        currentChart.options.plugins.tooltip.titleColor = tooltipTitle;
        currentChart.options.plugins.tooltip.bodyColor = tooltipBody;
        
        currentChart.update();
    }

    // Load Live Market Sidebar data on startup
    loadSidebarData();

    async function loadSidebarData() {
        try {
            const res = await fetch(SIDEBAR_API_URL);
            const data = await res.json();
            if(!data.error) {
                populateSidebarList('market-indices', data.indices);
                populateSidebarList('trending-stocks', data.trending);
                populateSidebarList('sector-perf', data.sectors);
            }
        } catch (e) {
            console.error("Failed to load sidebar data", e);
        }
    }

    function populateSidebarList(elementId, items) {
        const el = document.getElementById(elementId);
        el.innerHTML = '';
        items.forEach(item => {
            const name = item.name || item.symbol;
            const price = item.price ? `$${item.price}` : '';
            const changeClass = item.change >= 0 ? 'pos' : 'neg';
            const changeSign = item.change >= 0 ? '+' : '';
            
            const li = document.createElement('li');
            li.innerHTML = `
                <div class="sidebar-item-header">
                    <span class="ticker-name">${name}</span>
                    <span class="ticker-price">${price}</span>
                </div>
                <div class="ticker-change ${changeClass}">${changeSign}${item.change}%</div>
            `;
            if (item.symbol) {
                li.style.cursor = 'pointer';
                li.onclick = () => {
                    tickerInput.value = item.symbol;
                    document.getElementById('market-select').value = "";
                    performAnalysis();
                };
            }
            el.appendChild(li);
        });
    }

    analyzeBtn.addEventListener('click', performAnalysis);
    tickerInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            performAnalysis();
        }
    });

    async function performAnalysis() {
        const marketSuffix = document.getElementById('market-select').value;
        let ticker = tickerInput.value.trim().toUpperCase();
        
        if (!ticker) {
            showError("Please enter a stock ticker.");
            return;
        }
        
        // Append market suffix if one is selected and not already in the ticker
        if (marketSuffix && !ticker.endsWith(marketSuffix.toUpperCase())) {
            ticker += marketSuffix.toUpperCase();
        }

        // Reset UI
        errorEl.classList.add('hidden');
        resultsSection.classList.add('hidden');
        loadingEl.classList.remove('hidden');

        try {
            // Fetch Sentiment and Details in parallel
            const [sentimentRes, detailsRes] = await Promise.all([
                fetch(`${API_URL}?ticker=${ticker}`),
                fetch(`${DETAILS_API_URL}?ticker=${ticker}`)
            ]);

            const sentimentData = await sentimentRes.json();
            const detailsData = await detailsRes.json();

            if (sentimentData.error) {
                showError(sentimentData.error);
                return;
            }

            updateDashboard(sentimentData);
            if (!detailsData.error) {
                updateV2Dashboard(detailsData);
                updateChart(detailsData);
            }
            
            loadingEl.classList.add('hidden');
            resultsSection.classList.remove('hidden');
        } catch (error) {
            showError("Failed to connect to the backend server. Is it running?");
            loadingEl.classList.add('hidden');
        }
    }

    function updateChart(data) {
        const ctx = document.getElementById('priceChart').getContext('2d');
        
        if (currentChart) {
            currentChart.destroy();
        }

        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(96, 165, 250, 0.4)'); // Light blue, semi-transparent
        gradient.addColorStop(1, 'rgba(96, 165, 250, 0.0)'); // Transparent at bottom

        currentChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.dates,
                datasets: [
                {
                    type: 'bar',
                    label: 'Volume',
                    data: data.volumes,
                    backgroundColor: 'rgba(148, 163, 184, 0.1)',
                    yAxisID: 'y1'
                },
                {
                    type: 'line',
                    label: 'Closing Price',
                    data: data.prices,
                    borderColor: '#60a5fa', // Vibrant blue
                    backgroundColor: gradient,
                    borderWidth: 3,
                    pointBackgroundColor: '#fff',
                    pointBorderColor: '#60a5fa',
                    pointBorderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    fill: true,
                    tension: 0.4, // Smooth curves
                    yAxisID: 'y'
                },
                {
                    type: 'line',
                    label: 'SMA 50',
                    data: data.sma50,
                    borderColor: '#f59e0b', // Amber
                    borderWidth: 1.5,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false,
                    yAxisID: 'y'
                },
                {
                    type: 'line',
                    label: 'SMA 200',
                    data: data.sma200,
                    borderColor: '#ef4444', // Red
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false,
                    yAxisID: 'y'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: { display: true, labels: { color: '#cbd5e1' } },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        titleColor: '#f8fafc',
                        bodyColor: '#cbd5e1',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12
                    }
                },
                scales: {
                    x: { 
                        ticks: { color: '#64748b', maxTicksLimit: 6 }, 
                        grid: { display: false } // Hide vertical grid lines
                    },
                    y: { 
                        position: 'left',
                        ticks: { color: '#64748b', callback: function(value) { return '$' + value; } }, 
                        grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false, borderDash: [5, 5] } 
                    },
                    y1: {
                        position: 'right',
                        display: false,
                        grid: { display: false }
                    }
                }
            }
        });
    }

    function updateV2Dashboard(data) {
        // Fundamentals
        document.getElementById('f-mcap').textContent = formatNumber(data.fundamentals.marketCap);
        document.getElementById('f-pe').textContent = data.fundamentals.trailingPE;
        document.getElementById('f-pb').textContent = data.fundamentals.priceToBook;
        document.getElementById('f-de').textContent = data.fundamentals.debtToEquity;
        document.getElementById('f-roe').textContent = data.fundamentals.returnOnEquity + '%';
        document.getElementById('f-rec').textContent = data.fundamentals.recommendation;
        document.getElementById('f-trend').textContent = data.trend;
        document.getElementById('f-trend').className = data.trend === 'Bullish' ? 'highlight' : (data.trend === 'Bearish' ? 'neg' : '');

        // SWOT
        const populateList = (id, items) => {
            const el = document.getElementById(id);
            el.innerHTML = '';
            (items || ['N/A']).forEach(item => {
                const li = document.createElement('li');
                li.textContent = item;
                el.appendChild(li);
            });
        };
        populateList('swot-s', data.swot.Strengths);
        populateList('swot-w', data.swot.Weaknesses);
        populateList('swot-o', data.swot.Opportunities);
        populateList('swot-t', data.swot.Threats);

        // Peers
        const tbody = document.getElementById('peer-tbody');
        tbody.innerHTML = '';
        data.peers.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${p.ticker}</strong></td>
                <td>${formatNumber(p.marketCap)}</td>
                <td>${p.pe}</td>
                <td>${formatNumber(p.revenue)}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    function formatNumber(num) {
        if (num === 'N/A' || !num) return num;
        if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
        if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
        return num;
    }

    function updateDashboard(data) {
        // Volatility Warning
        const warningEl = document.getElementById('volatility-warning');
        if (data.volatility_warning) {
            warningEl.classList.remove('hidden');
        } else {
            warningEl.classList.add('hidden');
        }

        // Reddit Sentiment
        const redditSentimentEl = document.getElementById('reddit-sentiment');
        const redditMentionsEl = document.getElementById('reddit-mentions');
        if (data.reddit_sentiment) {
            redditSentimentEl.textContent = data.reddit_sentiment.status;
            redditSentimentEl.className = `sentiment-badge large ${data.reddit_sentiment.status}`;
            redditMentionsEl.textContent = data.reddit_sentiment.mentions;
        }

        overallSentiment.textContent = data.overall_sentiment;
        overallSentiment.className = `sentiment-badge large ${data.overall_sentiment}`;

        statPos.textContent = data.stats.positive;
        statNeu.textContent = data.stats.neutral;
        statNeg.textContent = data.stats.negative;

        newsList.innerHTML = '';
        if (data.news.length === 0) {
            newsList.innerHTML = '<p style="color: #94a3b8;">No recent news found to analyze.</p>';
            return;
        }

        data.news.forEach(item => {
            const newsCard = document.createElement('div');
            newsCard.className = `news-card glass ${item.sentiment}`;
            
            const confPercent = (item.confidence * 100).toFixed(1) + '%';
            
            // Format Date
            let dateStr = '';
            if (item.pubDate) {
                const dateObj = new Date(item.pubDate);
                dateStr = ' • ' + dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            }
            
            newsCard.innerHTML = `
                <div class="news-content">
                    <h4 class="news-title">
                        <a href="${item.link}" target="_blank" rel="noopener noreferrer">${item.title}</a>
                    </h4>
                    <div class="news-meta">
                        <span>Source: ${item.publisher || 'Unknown'}${dateStr}</span>
                    </div>
                    ${item.highlight ? `<div class="news-highlight">💡 <span>${item.highlight}</span></div>` : ''}
                </div>
                <div class="news-sentiment">
                    <span class="sentiment-badge ${item.sentiment}">${item.sentiment}</span>
                    <span class="confidence">${confPercent} conf</span>
                </div>
            `;
            newsList.appendChild(newsCard);
        });
    }

    function showError(message) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
        loadingEl.classList.add('hidden');
    }
});
