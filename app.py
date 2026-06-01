from flask import Flask, render_template, request, jsonify
import sqlite3, os, requests, json, time
from datetime import datetime, timezone, timedelta

app = Flask(__name__)

# ── Configuração ──────────────────────────────────────────────
# Usa disco persistente do Render em produção, local em dev
_DATA_DIR   = '/data' if os.path.isdir('/data') else os.path.dirname(__file__)
DB_PATH     = os.path.join(_DATA_DIR, 'settings.db')
META_API    = 'https://graph.facebook.com/v21.0'
LEAD_FIELDS = 'campaign_id,campaign_name,impressions,clicks,spend,ctr,cpm,cpc,frequency,reach,actions,action_values'

# Fuso horário de Brasília (UTC-3)
TZ_BR = timezone(timedelta(hours=-3))

# ── Cache simples em memória ──────────────────────────────────
_cache = {}   # {key: (timestamp, data)}
CACHE_TTL = 300  # 5 minutos

def cache_get(key):
    if key in _cache:
        ts, data = _cache[key]
        if time.time() - ts < CACHE_TTL:
            return data
        del _cache[key]
    return None

def cache_set(key, data):
    _cache[key] = (time.time(), data)

def cache_bust():
    """Limpa todo o cache (chamado após salvar settings)"""
    _cache.clear()

# ── Banco de dados ────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    db = get_db()
    db.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    db.commit(); db.close()

def load_settings():
    try:
        db = get_db()
        rows = db.execute('SELECT key, value FROM settings').fetchall()
        db.close()
        s = {r['key']: r['value'] for r in rows}
    except Exception:
        s = {}
    # Fallback para variáveis de ambiente (Render)
    if not s.get('access_token'):
        s['access_token'] = os.getenv('META_ACCESS_TOKEN', '')
    if not s.get('account_id'):
        s['account_id'] = os.getenv('META_ACCOUNT_ID', '')
    return s

def save_setting(key, value):
    db = get_db()
    db.execute(
        'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        (key, value, datetime.now().isoformat())
    )
    db.commit(); db.close()

# ── Helpers ───────────────────────────────────────────────────
def today_br():
    """Retorna data de hoje no fuso horário de Brasília (YYYY-MM-DD)"""
    return datetime.now(TZ_BR).strftime('%Y-%m-%d')

def aggregate_by_campaign(rows):
    """Agrega múltiplas linhas (time_increment=1) por campaign_id"""
    agg = {}
    for row in rows:
        cid = row.get('campaign_id')
        if not cid:
            continue
        if cid not in agg:
            agg[cid] = row.copy()
            for f in ['impressions', 'clicks', 'spend', 'reach']:
                agg[cid][f] = str(float(agg[cid].get(f, 0) or 0))
        else:
            for f in ['impressions', 'clicks', 'spend', 'reach']:
                agg[cid][f] = str(
                    float(agg[cid].get(f, 0) or 0) + float(row.get(f, 0) or 0)
                )
            # Merge actions
            ea = {a['action_type']: a for a in agg[cid].get('actions', [])}
            for act in row.get('actions', []):
                at = act['action_type']
                if at in ea:
                    ea[at]['value'] = str(float(ea[at].get('value', 0)) + float(act.get('value', 0)))
                else:
                    ea[at] = act.copy()
            agg[cid]['actions'] = list(ea.values())

            # Recalcula métricas derivadas (médias ponderadas simples)
            imps = float(agg[cid].get('impressions', 0) or 0)
            clicks = float(agg[cid].get('clicks', 0) or 0)
            spend = float(agg[cid].get('spend', 0) or 0)
            agg[cid]['ctr'] = str(round(clicks / imps * 100, 4)) if imps > 0 else '0'
            agg[cid]['cpm'] = str(round(spend / imps * 1000, 4)) if imps > 0 else '0'
            agg[cid]['cpc'] = str(round(spend / clicks, 4)) if clicks > 0 else '0'

    return list(agg.values())

# ── CORS para facilitar chamadas externas ─────────────────────
@app.after_request
def add_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response

# ── Rotas ─────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'time_br': today_br()})

# ── API: Configurações ────────────────────────────────────────
@app.route('/api/settings', methods=['GET'])
def get_settings():
    s = load_settings()
    token = s.get('access_token', '')
    acct  = s.get('account_id', '')
    return jsonify({
        'account_id':    acct,
        'has_token':     bool(token),
        'token_preview': (token[:8] + '...' + token[-4:]) if len(token) > 12 else ('✓' if token else '')
    })

@app.route('/api/settings', methods=['POST'])
def save_settings():
    data = request.json or {}
    if 'account_id'   in data: save_setting('account_id',   data['account_id'])
    if 'access_token' in data: save_setting('access_token', data['access_token'])
    cache_bust()   # limpa cache ao trocar credenciais
    return jsonify({'ok': True})

# ── API: Campanhas ────────────────────────────────────────────
@app.route('/api/campaigns')
def get_campaigns():
    s     = load_settings()
    token = s.get('access_token')
    acct  = 'act_' + s.get('account_id', '').replace('act_', '').strip()
    if not token or not s.get('account_id'):
        return jsonify({'error': 'Credenciais não configuradas'}), 401

    cache_key = f'campaigns:{acct}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    try:
        r = requests.get(f'{META_API}/{acct}/campaigns', params={
            'fields': 'id,name,status,effective_status,daily_budget,lifetime_budget,objective,created_time',
            'limit': 250,
            'access_token': token
        }, timeout=30)
        data = r.json()
        if 'data' in data:
            cache_set(cache_key, data)
        return jsonify(data), r.status_code
    except Exception as e:
        return jsonify({'error': {'message': str(e), 'type': 'RequestException'}}), 500

# ── API: Insights ─────────────────────────────────────────────
@app.route('/api/insights')
def get_insights():
    s     = load_settings()
    token = s.get('access_token')
    acct  = 'act_' + s.get('account_id', '').replace('act_', '').strip()
    if not token or not s.get('account_id'):
        return jsonify({'error': 'Credenciais não configuradas'}), 401

    since       = request.args.get('since')
    until       = request.args.get('until')
    date_preset = request.args.get('date_preset', 'last_30d')

    # Se pedirem "hoje" sem passar datas, calcula no fuso BR
    if date_preset == 'today' and not since:
        since = until = today_br()

    is_single_day = (since and until and since == until)

    params = {
        'level':        'campaign',
        'fields':       LEAD_FIELDS,
        'limit':        250,
        'access_token': token,
    }

    if since and until:
        params['time_range'] = json.dumps({'since': since, 'until': until})
        if is_single_day:
            params['time_increment'] = 1   # obrigatório para queries de 1 dia
    else:
        params['date_preset'] = date_preset

    cache_key = f'insights:{acct}:{since or date_preset}:{until or ""}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    try:
        r = requests.get(f'{META_API}/{acct}/insights', params=params, timeout=45)
        data = r.json()

        if is_single_day and 'data' in data:
            data['data'] = aggregate_by_campaign(data.get('data', []))

        if 'data' in data:
            cache_set(cache_key, data)
        return jsonify(data), r.status_code

    except Exception as e:
        return jsonify({'error': {'message': str(e), 'type': 'RequestException'}}), 500

# ── Inicialização ─────────────────────────────────────────────
init_db()

if __name__ == '__main__':
    print('Consig Tech — Meta Ads rodando em http://localhost:5000')
    app.run(debug=True, port=5000)
