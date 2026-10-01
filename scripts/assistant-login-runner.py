#!/usr/bin/env python3
"""
Continuous Telegram MTProto Auth Runner for Pappy / Omega Assistant.
Keeps the MTProto session_id alive between send_code and sign_in.
"""
import os
import sys
import json
import time
import asyncio
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"
STATUS_FILE = Path("/tmp/pappy_auth_status.json")
INPUT_FILE = Path("/tmp/pappy_auth_input.json")
RUNNER_PID_FILE = Path("/tmp/pappy_auth_runner.pid")

def load_env():
    env = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    return env

def update_env(key: str, val: str):
    lines = []
    found = False
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith(f"{key}="):
                lines.append(f"{key}={val}")
                found = True
            else:
                lines.append(line)
    if not found:
        lines.append(f"{key}={val}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")

def get_api_credentials():
    env = load_env()
    api_id_str = env.get("TELEGRAM_API_ID") or env.get("STREAM_API_ID")
    api_hash = env.get("TELEGRAM_API_HASH") or env.get("STREAM_API_HASH")
    if not api_id_str or not api_hash:
        raise RuntimeError("TELEGRAM_API_ID or TELEGRAM_API_HASH missing in .env")
    return int(api_id_str), api_hash

async def run_daemon(phone: str):
    RUNNER_PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    api_id, api_hash = get_api_credentials()
    from pyrogram import Client
    from pyrogram.errors import SessionPasswordNeeded, PhoneCodeInvalid, PasswordHashInvalid, PhoneCodeExpired

    app = Client("/tmp/pappy_auth_live_session", api_id=api_id, api_hash=api_hash)
    await app.connect()
    
    try:
        sent = await app.send_code(phone)
        STATUS_FILE.write_text(json.dumps({
            "status": "code_sent",
            "phone": phone,
            "hash": sent.phone_code_hash,
            "time": time.time()
        }), encoding="utf-8")
        print(f"Code sent to {phone}. Waiting for code in {INPUT_FILE}...")
    except Exception as e:
        STATUS_FILE.write_text(json.dumps({"status": "error", "error": str(e)}), encoding="utf-8")
        await app.disconnect()
        return

    # Wait for user input file for up to 300 seconds
    start_time = time.time()
    code_entered = False
    while time.time() - start_time < 300:
        if INPUT_FILE.exists():
            try:
                data = json.loads(INPUT_FILE.read_text(encoding="utf-8"))
            except Exception:
                await asyncio.sleep(0.5)
                continue
                
            code = data.get("code", "").strip()
            password = data.get("password")
            INPUT_FILE.unlink(missing_ok=True)
            
            if not code and not password:
                await asyncio.sleep(0.5)
                continue
                
            try:
                if code and not code_entered:
                    try:
                        await app.sign_in(phone, sent.phone_code_hash, code)
                        code_entered = True
                    except SessionPasswordNeeded:
                        code_entered = True
                        if password:
                            await app.check_password(password)
                        else:
                            STATUS_FILE.write_text(json.dumps({
                                "status": "needs_password",
                                "message": "Two-step verification password (2FA) is required."
                            }), encoding="utf-8")
                            continue
                elif password and code_entered:
                    await app.check_password(password)
                
                # Successful sign in
                me = await app.get_me()
                session_string = await app.export_session_string()
                update_env("STREAM_SESSION_STRING", session_string)
                
                STATUS_FILE.write_text(json.dumps({
                    "status": "success",
                    "user": {
                        "id": me.id,
                        "first_name": me.first_name,
                        "username": me.username
                    }
                }), encoding="utf-8")
                
                print("Signed in successfully! Session exported.")
                await app.disconnect()
                
                # Restart stream worker
                os.system("supervisorctl restart pappy-stream-worker")
                return

            except PhoneCodeInvalid:
                STATUS_FILE.write_text(json.dumps({"status": "error", "error": "Invalid verification code"}), encoding="utf-8")
            except PhoneCodeExpired:
                STATUS_FILE.write_text(json.dumps({"status": "error", "error": "Code expired"}), encoding="utf-8")
            except PasswordHashInvalid:
                STATUS_FILE.write_text(json.dumps({"status": "error", "error": "Invalid 2FA password"}), encoding="utf-8")
            except Exception as e:
                STATUS_FILE.write_text(json.dumps({"status": "error", "error": str(e)}), encoding="utf-8")

        await asyncio.sleep(0.5)

    STATUS_FILE.write_text(json.dumps({"status": "timeout", "error": "Timed out waiting for input"}), encoding="utf-8")
    await app.disconnect()

def main():
    if len(sys.argv) < 2:
        print("Usage: assistant-login-runner.py start <phone> | submit <code> [password] | status")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "start":
        phone = sys.argv[2]
        # Clean previous state
        STATUS_FILE.unlink(missing_ok=True)
        INPUT_FILE.unlink(missing_ok=True)
        asyncio.run(run_daemon(phone))
    elif cmd == "submit":
        code = sys.argv[2]
        password = sys.argv[3] if len(sys.argv) > 3 else None
        INPUT_FILE.write_text(json.dumps({"code": code, "password": password}), encoding="utf-8")
        print("Submitted input.")
    elif cmd == "status":
        if STATUS_FILE.exists():
            print(STATUS_FILE.read_text(encoding="utf-8"))
        else:
            print(json.dumps({"status": "idle"}))

if __name__ == "__main__":
    main()
