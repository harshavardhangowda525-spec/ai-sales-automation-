"""Minimal Sarvam AI chat completion: reads SARVAM_API_KEY from the environment (or .env)."""
import os
import sys
from pathlib import Path

from sarvamai import SarvamAI


def load_dotenv(path=Path(__file__).with_name(".env")):
    """Load KEY=value lines from .env into os.environ (without overriding existing vars)."""
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv()
api_key = os.environ.get("SARVAM_API_KEY")
if not api_key:
    sys.exit("SARVAM_API_KEY is not set. Add it to .env (SARVAM_API_KEY=...) and run again.")

client = SarvamAI(api_subscription_key=api_key)
response = client.chat.completions(
    model="sarvam-105b-conversations",
    messages=[{"role": "user", "content": "Say hello in one short sentence."}],
)
print(response.choices[0].message.content)
