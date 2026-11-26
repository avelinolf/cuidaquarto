"""Sensor virtual do CuidaQuarto.

Publica temperatura e umidade em MQTT a cada INTERVALO segundos.
Cenario atual pode ser trocado em tempo de execucao publicando em
cuidaquarto/sim/cenario  (normal | onda_calor | queda_umidade | falha_sensor)

Uso:
    pip install paho-mqtt python-dotenv
    python simulador.py --cenario normal
"""
import argparse
import os
import random
import time

import paho.mqtt.client as mqtt

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

HOST = os.getenv("MQTT_HOST", "localhost")
PORT = int(os.getenv("MQTT_PORT", "1883"))
USER = os.getenv("MQTT_USER") or None
PASS = os.getenv("MQTT_PASS") or None

T_TEMP = "cuidaquarto/sensor/temperatura"
T_UMID = "cuidaquarto/sensor/umidade"
T_STATUS = "cuidaquarto/sensor/status"      # online | offline (LWT)
T_CENARIO = "cuidaquarto/sim/cenario"

CENARIOS = {"normal", "onda_calor", "queda_umidade", "falha_sensor"}


class Estado:
    temp = 25.0
    umid = 55.0
    cenario = "normal"


def alvo(cenario):
    """Valores para os quais temperatura/umidade tendem em cada cenario."""
    if cenario == "onda_calor":
        return 34.0, 40.0
    if cenario == "queda_umidade":
        return 26.0, 25.0
    return 25.0, 55.0


def on_connect(client, userdata, flags, rc, properties=None):
    print(f"[mqtt] conectado rc={rc}")
    client.subscribe(T_CENARIO)
    client.publish(T_STATUS, "online", retain=True)


def on_message(client, userdata, msg):
    novo = msg.payload.decode().strip()
    if msg.topic == T_CENARIO and novo in CENARIOS:
        Estado.cenario = novo
        print(f"[sim] cenario -> {novo}")


def passo():
    t_alvo, u_alvo = alvo(Estado.cenario)
    # aproxima 8% do alvo a cada passo + ruido
    Estado.temp += (t_alvo - Estado.temp) * 0.08 + random.uniform(-0.15, 0.15)
    Estado.umid += (u_alvo - Estado.umid) * 0.08 + random.uniform(-0.4, 0.4)
    Estado.umid = max(5.0, min(95.0, Estado.umid))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cenario", default="normal", choices=sorted(CENARIOS))
    ap.add_argument("--intervalo", type=float, default=5.0)
    args = ap.parse_args()
    Estado.cenario = args.cenario

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if USER:
        client.username_pw_set(USER, PASS)
    client.will_set(T_STATUS, "offline", retain=True)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(HOST, PORT, 60)
    client.loop_start()

    try:
        while True:
            if Estado.cenario == "falha_sensor":
                # sensor "mudo": nao publica leituras e sinaliza offline
                client.publish(T_STATUS, "offline", retain=True)
            else:
                passo()
                client.publish(T_STATUS, "online", retain=True)
                client.publish(T_TEMP, f"{Estado.temp:.1f}", retain=True)
                client.publish(T_UMID, f"{Estado.umid:.1f}", retain=True)
                print(f"[{Estado.cenario}] T={Estado.temp:.1f}C U={Estado.umid:.1f}%")
            time.sleep(args.intervalo)
    except KeyboardInterrupt:
        client.publish(T_STATUS, "offline", retain=True)
        client.loop_stop()


if __name__ == "__main__":
    main()
