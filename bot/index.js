// Bot WhatsApp <-> MQTT do CuidaQuarto.
//
// Papel: ponte. Recebe mensagens, filtra por numero autorizado e rate limit,
// e publica texto livre em bot/entrada (para o agente LLM). Mensagens vindas de
// bot/saida sao enviadas no WhatsApp.
//
// Fallback (sem LLM): comandos /ligar, /desligar, /status, /ajuda sao tratados
// aqui mesmo, apenas para dispositivos da allowlist.

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mqtt = require('mqtt');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ---------- configuracao ----------
const MQTT_URL = `mqtt://${process.env.MQTT_HOST || 'localhost'}:${process.env.MQTT_PORT || 1883}`;
const MQTT_USER = process.env.MQTT_USER || undefined;
const MQTT_PASS = process.env.MQTT_PASS || undefined;

const AUTORIZADOS = (process.env.AUTHORIZED_NUMBERS || '')
  .split(',')
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean);

const DISPOSITIVOS = ['ventilador', 'luz', 'umidificador']; // allowlist
const LIMITE_MSG_POR_MIN = 10;

const TOPICO_ENTRADA = 'bot/entrada';
const TOPICO_SAIDA = 'bot/saida';

if (AUTORIZADOS.length === 0) {
  console.error('AUTHORIZED_NUMBERS vazio no .env. Abortando por seguranca.');
  process.exit(1);
}

// ---------- auditoria ----------
const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
function auditar(evento) {
  const linha = JSON.stringify({ ts: new Date().toISOString(), ...evento });
  fs.appendFileSync(path.join(LOG_DIR, 'auditoria.jsonl'), linha + '\n');
}

// ---------- MQTT ----------
const cache = { temperatura: null, umidade: null, sensor: null, dispositivos: {} };

const mqttClient = mqtt.connect(MQTT_URL, { username: MQTT_USER, password: MQTT_PASS });

mqttClient.on('connect', () => {
  console.log('[mqtt] conectado');
  mqttClient.subscribe([
    TOPICO_SAIDA,
    'cuidaquarto/sensor/temperatura',
    'cuidaquarto/sensor/umidade',
    'cuidaquarto/sensor/status',
    ...DISPOSITIVOS.map((d) => `cuidaquarto/dispositivo/${d}/state`),
  ]);
});

mqttClient.on('error', (e) => console.error('[mqtt] erro:', e.message));

mqttClient.on('message', async (topic, buf) => {
  const payload = buf.toString();
  if (topic === 'cuidaquarto/sensor/temperatura') cache.temperatura = payload;
  else if (topic === 'cuidaquarto/sensor/umidade') cache.umidade = payload;
  else if (topic === 'cuidaquarto/sensor/status') cache.sensor = payload;
  else if (topic.startsWith('cuidaquarto/dispositivo/')) {
    cache.dispositivos[topic.split('/')[2]] = payload;
  } else if (topic === TOPICO_SAIDA) {
    await tratarSaida(payload);
  }
});

function publicarComando(dispositivo, acao) {
  // Unico ponto que publica em topico de dispositivo. Valida allowlist.
  if (!DISPOSITIVOS.includes(dispositivo)) return false;
  if (!['ON', 'OFF'].includes(acao)) return false;
  mqttClient.publish(`cuidaquarto/dispositivo/${dispositivo}/set`, acao);
  return true;
}

// ---------- WhatsApp ----------
const wa = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

wa.on('qr', (qr) => {
  console.log('Escaneie o QR code com o WhatsApp do chip secundario:');
  qrcode.generate(qr, { small: true });
});
wa.on('ready', () => console.log('[whatsapp] pronto'));
wa.on('auth_failure', (m) => console.error('[whatsapp] falha de autenticacao:', m));
wa.on('disconnected', (r) => console.error('[whatsapp] desconectado:', r));

// rate limit: janela deslizante de 60 s por numero
const janelas = new Map();
function dentroDoLimite(numero) {
  const agora = Date.now();
  const lista = (janelas.get(numero) || []).filter((t) => agora - t < 60000);
  if (lista.length >= LIMITE_MSG_POR_MIN) {
    janelas.set(numero, lista);
    return false;
  }
  lista.push(agora);
  janelas.set(numero, lista);
  return true;
}

function resumoStatus() {
  const disp = DISPOSITIVOS.map((d) => `${d}: ${cache.dispositivos[d] || '?'}`).join('\n');
  return (
    `🌡️ Temperatura: ${cache.temperatura ?? '?'} °C\n` +
    `💧 Umidade: ${cache.umidade ?? '?'} %\n` +
    `📡 Sensor: ${cache.sensor ?? '?'}\n\n${disp}`
  );
}

function tratarComandoDireto(texto) {
  const partes = texto.trim().toLowerCase().split(/\s+/);
  const cmd = partes[0];

  if (cmd === '/status') return { resposta: resumoStatus(), executado: 'status' };

  if (cmd === '/ajuda') {
    return {
      resposta:
        'Comandos:\n/status\n/ligar <dispositivo>\n/desligar <dispositivo>\n' +
        `Dispositivos: ${DISPOSITIVOS.join(', ')}\n` +
        'Ou escreva em linguagem natural.',
      executado: 'ajuda',
    };
  }

  if (cmd === '/ligar' || cmd === '/desligar') {
    const dispositivo = partes[1];
    const acao = cmd === '/ligar' ? 'ON' : 'OFF';
    if (!publicarComando(dispositivo, acao)) {
      return {
        resposta: `Dispositivo invalido. Use: ${DISPOSITIVOS.join(', ')}`,
        executado: 'recusado',
      };
    }
    return {
      resposta: `✅ ${dispositivo} -> ${acao === 'ON' ? 'ligado' : 'desligado'}`,
      executado: `${dispositivo}:${acao}`,
    };
  }

  return null; // nao e comando direto
}

wa.on('message', async (msg) => {
  try {
    if (msg.from.endsWith('@g.us') || msg.fromMe) return; // ignora grupos e proprias
    const contato = await msg.getContact();
    const numero = String(contato.number || '').replace(/\D/g, '');

    if (!AUTORIZADOS.includes(numero)) {
      auditar({ de: numero, texto: msg.body, resultado: 'ignorado_nao_autorizado' });
      return; // silencio total
    }

    if (!dentroDoLimite(numero)) {
      auditar({ de: numero, texto: msg.body, resultado: 'rate_limit' });
      await msg.reply('⏳ Muitas mensagens. Aguarde um minuto.');
      return;
    }

    const texto = (msg.body || '').trim();
    if (!texto) return;

    if (texto.startsWith('/')) {
      const r = tratarComandoDireto(texto);
      if (r) {
        auditar({ de: numero, texto, entendido: 'comando_direto', executado: r.executado });
        await msg.reply(r.resposta);
        return;
      }
    }

    // Texto livre: encaminha ao agente LLM.
    mqttClient.publish(
      TOPICO_ENTRADA,
      JSON.stringify({ de: numero, texto, ts: Date.now() })
    );
    auditar({ de: numero, texto, entendido: 'encaminhado_ao_agente' });
  } catch (e) {
    console.error('[whatsapp] erro ao tratar mensagem:', e);
  }
});

async function enviar(numero, texto) {
  const id = await wa.getNumberId(numero);
  if (!id) {
    console.error('[whatsapp] numero nao encontrado no WhatsApp:', numero);
    return;
  }
  await wa.sendMessage(id._serialized, texto);
}

async function tratarSaida(payload) {
  let dados;
  try {
    dados = JSON.parse(payload);
  } catch {
    console.error('[bot] bot/saida com JSON invalido');
    return;
  }
  const texto = String(dados.texto || '').trim();
  if (!texto) return;

  let destinos;
  if (dados.destino === 'autorizados') destinos = AUTORIZADOS;
  else {
    const n = String(dados.destino || '').replace(/\D/g, '');
    destinos = AUTORIZADOS.includes(n) ? [n] : []; // nunca envia fora da lista
  }

  for (const n of destinos) {
    try {
      await enviar(n, texto);
      auditar({ para: n, texto, resultado: 'enviado' });
    } catch (e) {
      console.error('[whatsapp] falha ao enviar:', e.message);
    }
  }
}

wa.initialize();