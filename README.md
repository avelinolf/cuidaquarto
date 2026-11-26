# CuidaQuarto

Monitoramento inteligente do quarto de **idosos ou crianças** com Home Assistant, MQTT, WhatsApp e um agente LLM (Hermes) com ferramentas e camada de segurança.

Projeto da Unidade III — Tecnologia da Informação para Internet das Coisas.

## Ideia

Um mesmo sistema, três **modos** (desafio criativo "cenários por contexto"):

| Modo | Foco | Exemplo de regra |
|------|------|------------------|
| `idoso` | conforto térmico e hidratação do ar | alerta se T ≥ 28 °C ou umidade < 40 % |
| `crianca` | faixa de temperatura estreita, luz noturna | alerta se T < 20 °C ou T ≥ 27 °C |
| `dormir` | silêncio e discrição | só alertas críticos (T ≥ 30 °C ou sensor offline) |

Requisito fixo do enunciado (sem LLM): **T ≥ 30 °C → alerta no WhatsApp** (`homeassistant/automations.yaml`).

## Arquitetura

```
Sensor virtual --MQTT--> Mosquitto <--> Home Assistant (dashboard, histórico, automações)
                            ^
WhatsApp <--> Bot (whatsapp-web.js) <--MQTT (bot/entrada, bot/saida)--> Agente LLM (Hermes + tools)
```

## Tópicos MQTT

| Tópico | Direção | Conteúdo |
|--------|---------|----------|
| `cuidaquarto/sensor/temperatura` | sensor → | `26.4` |
| `cuidaquarto/sensor/umidade` | sensor → | `52.1` |
| `cuidaquarto/sensor/status` | sensor → | `online` / `offline` (LWT) |
| `cuidaquarto/sim/cenario` | → sensor | `normal`, `onda_calor`, `queda_umidade`, `falha_sensor` |
| `cuidaquarto/dispositivo/<ventilador\|luz\|umidificador>/set` | → atuador | `ON` / `OFF` |
| `cuidaquarto/dispositivo/<...>/state` | atuador → | `ON` / `OFF` |
| `bot/entrada` | bot → agente | JSON `{"de": "...", "texto": "..."}` |
| `bot/saida` | → bot | JSON `{"destino": "autorizados", "texto": "..."}` |

## Como subir (Semana 1)

```bash
cp .env.example .env
docker compose up -d
# Home Assistant: http://localhost:8123
#   Configurações > Dispositivos e serviços > Adicionar integração > MQTT
#   Broker: mosquitto   Porta: 1883

python -m venv .venv && source .venv/bin/activate
pip install -r sensor/requirements.txt
python sensor/atuadores.py &          # eco dos comandos
python sensor/simulador.py            # publica T e U
```

Trocar o cenário em tempo real (útil para o vídeo):

```bash
docker exec mosquitto mosquitto_pub -t cuidaquarto/sim/cenario -m onda_calor
```

## Plano ajustado: 2 semanas (entrega 09/12/2026)

| Período | Entrega |
|---------|---------|
| 25–27/11 | Infra, sensor, entidades, **dashboard** (esta base) |
| 28/11–01/12 | Bot WhatsApp ↔ MQTT, alerta fixo, comandos `/ligar`, `/desligar`, `/status` |
| 02–05/12 | Agente LLM com 3+ tools (`ler_sensor`, `controlar_dispositivo`, `consultar_historico`) + segurança |
| 06–07/12 | Desafio criativo (modos) + testes de falha |
| 08/12 | Gravar vídeo, documento (2–3 pág.), exportar config do HA |
| 09/12 | Entrega |

## Segurança (resumo do que será implementado)

Números autorizados, allowlist de ferramentas e tópicos, confirmação "SIM" para ações sensíveis, tempo máximo de acionamento, rate limit, log de auditoria e fallback para comandos simples se o LLM cair.

## Não versionar

`.env`, `.wwebjs_auth/`, senhas do broker e chaves de API (ver `.gitignore`).

## Uso responsável de IA

Parágrafo a ser preenchido na entrega: indicar que a estrutura inicial do repositório foi gerada com apoio de assistente de IA e revisada pelos autores.
