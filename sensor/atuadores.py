"""Atuadores virtuais: ecoam cuidaquarto/dispositivo/<nome>/set em .../state.

Faz o papel de um ESP32 com rele. Quando houver hardware real, este script
deixa de ser necessario.
"""
import os

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

DISPOSITIVOS = ["ventilador", "luz", "umidificador"]


def on_connect(client, userdata, flags, rc, properties=None):
    for d in DISPOSITIVOS:
        client.subscribe(f"cuidaquarto/dispositivo/{d}/set")
        client.publish(f"cuidaquarto/dispositivo/{d}/state", "OFF", retain=True)
    print("[atuadores] prontos:", DISPOSITIVOS)


def on_message(client, userdata, msg):
    nome = msg.topic.split("/")[2]
    valor = msg.payload.decode().strip().upper()
    if nome in DISPOSITIVOS and valor in ("ON", "OFF"):
        client.publish(f"cuidaquarto/dispositivo/{nome}/state", valor, retain=True)
        print(f"[atuadores] {nome} -> {valor}")


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
if USER:
    client.username_pw_set(USER, PASS)
client.on_connect = on_connect
client.on_message = on_message
client.connect(HOST, PORT, 60)
client.loop_forever()
