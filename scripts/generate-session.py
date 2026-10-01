#!/usr/bin/env python3
"""
Assistant Session Manager & Generator for Pappy / Omega.
Supports:
1. Interactive wizard: `python scripts/generate-session.py`
2. Step-by-step CLI:
   - `python scripts/generate-session.py send-code +1234567890`
   - `python scripts/generate-session.py verify-code 12345 [--password 2FA]`
3. Direct session string test & set:
   - `python scripts/generate-session.py set-string <STRING>`
   - `python scripts/generate-session.py test`
"""
import os
import sys
import json
import argparse
import asyncio
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"
LOGIN_STATE_FILE = Path("/tmp/pappy_assistant_login_state.json")
TEMP_SESSION_BASE = "/tmp/pappy_assistant_temp"
TEMP_SESSION_FILE = Path(f"{TEMP_SESSION_BASE}.session")

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
        print(json.dumps({"ok": False, "error": "TELEGRAM_API_ID or TELEGRAM_API_HASH missing in .env"}))
        sys.exit(1)
    return int(api_id_str), api_hash

def restart_worker():
    print("🔄 Restarting pappy-stream-worker...")
    ret = os.system("supervisorctl restart pappy-stream-worker")
    if ret == 0:
        print("✅ pappy-stream-worker restarted successfully.")
    else:
        print(f"⚠️ supervisorctl restart returned exit code {ret}")

async def cmd_send_code(phone: str):
    api_id, api_hash = get_api_credentials()
    from pyrogram import Client
    
    # Remove any leftover temporary session
    if TEMP_SESSION_FILE.exists():
        TEMP_SESSION_FILE.unlink()
        
    app = Client(TEMP_SESSION_BASE, api_id=api_id, api_hash=api_hash)
    await app.connect()
    
    try:
        sent = await app.send_code(phone)
        LOGIN_STATE_FILE.write_text(json.dumps({
            "phone": phone,
            "phone_code_hash": sent.phone_code_hash
        }), encoding="utf-8")
        await app.disconnect()
        print(json.dumps({
            "ok": True,
            "message": f"Verification code sent to Telegram app for {phone}",
            "phone": phone,
            "phone_code_hash": sent.phone_code_hash
        }, indent=2))
    except Exception as e:
        await app.disconnect()
        if TEMP_SESSION_FILE.exists():
            TEMP_SESSION_FILE.unlink()
        print(json.dumps({"ok": False, "error": str(e)}, indent=2))
        sys.exit(1)

async def cmd_verify_code(code: str, password: str = None):
    if not LOGIN_STATE_FILE.exists() or not TEMP_SESSION_FILE.exists():
        print(json.dumps({"ok": False, "error": "No pending login found. Run send-code first."}))
        sys.exit(1)
        
    state = json.loads(LOGIN_STATE_FILE.read_text(encoding="utf-8"))
    phone = state["phone"]
    phone_code_hash = state["phone_code_hash"]
    
    api_id, api_hash = get_api_credentials()
    from pyrogram import Client
    from pyrogram.errors import SessionPasswordNeeded, PhoneCodeInvalid, PasswordHashInvalid
    
    app = Client(TEMP_SESSION_BASE, api_id=api_id, api_hash=api_hash)
    await app.connect()
    
    try:
        await app.sign_in(phone, phone_code_hash, code)
    except SessionPasswordNeeded:
        if not password:
            await app.disconnect()
            print(json.dumps({"ok": False, "needs_password": True, "error": "Two-step verification password (2FA) is required."}))
            sys.exit(2)
        try:
            await app.check_password(password)
        except PasswordHashInvalid:
            await app.disconnect()
            print(json.dumps({"ok": False, "error": "Invalid 2FA password."}))
            sys.exit(1)
    except PhoneCodeInvalid:
        await app.disconnect()
        print(json.dumps({"ok": False, "error": "Invalid verification code."}))
        sys.exit(1)
    except Exception as e:
        await app.disconnect()
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
        
    me = await app.get_me()
    session_string = await app.export_session_string()
    await app.disconnect()
    
    # Save & clean up temp files
    update_env("STREAM_SESSION_STRING", session_string)
    if LOGIN_STATE_FILE.exists():
        LOGIN_STATE_FILE.unlink()
    if TEMP_SESSION_FILE.exists():
        TEMP_SESSION_FILE.unlink()
        
    print(json.dumps({
        "ok": True,
        "message": "Assistant authenticated and session saved to .env",
        "user": {
            "id": me.id,
            "first_name": me.first_name,
            "username": me.username
        }
    }, indent=2))
    
    restart_worker()

async def cmd_set_string(session_str: str):
    api_id, api_hash = get_api_credentials()
    from pyrogram import Client
    
    clean_str = session_str.strip().strip("'\"")
    app = Client("test_session_check", api_id=api_id, api_hash=api_hash, session_string=clean_str, in_memory=True)
    try:
        await app.connect()
        me = await app.get_me()
        await app.disconnect()
        
        update_env("STREAM_SESSION_STRING", clean_str)
        print(json.dumps({
            "ok": True,
            "message": "Session string verified and saved to .env",
            "user": {
                "id": me.id,
                "first_name": me.first_name,
                "username": me.username
            }
        }, indent=2))
        restart_worker()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to authenticate with session string: {e}"}))
        sys.exit(1)

async def cmd_test():
    env = load_env()
    session_str = env.get("STREAM_SESSION_STRING")
    if not session_str:
        print(json.dumps({"ok": False, "error": "STREAM_SESSION_STRING is not set in .env"}))
        sys.exit(1)
        
    api_id, api_hash = get_api_credentials()
    from pyrogram import Client
    app = Client("test_live_check", api_id=api_id, api_hash=api_hash, session_string=session_str, in_memory=True)
    try:
        await app.connect()
        me = await app.get_me()
        await app.disconnect()
        print(json.dumps({
            "ok": True,
            "status": "ready",
            "user": {
                "id": me.id,
                "first_name": me.first_name,
                "username": me.username
            }
        }, indent=2))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)

async def cmd_interactive():
    api_id, api_hash = get_api_credentials()
    from pyrogram import Client
    from pyrogram.errors import SessionPasswordNeeded, PhoneCodeInvalid, PasswordHashInvalid
    
    print("=" * 60)
    print("🔑 PAPPY / OMEGA ASSISTANT SESSION GENERATOR")
    print("=" * 60)
    print(f"API ID:   {api_id}")
    print(f"API Hash: {api_hash[:6]}...{api_hash[-4:]}")
    print("=" * 60)
    print("NOTE: Use a spare Telegram account for the assistant (never main).")
    print("=" * 60)
    
    app = Client("pappy-session-gen", api_id=api_id, api_hash=api_hash, in_memory=True)
    await app.connect()
    
    phone = input("\nEnter phone number with country code (e.g. +1234567890): ").strip()
    try:
        sent_code = await app.send_code(phone)
    except Exception as e:
        print(f"❌ Failed to send code: {e}")
        await app.disconnect()
        sys.exit(1)
        
    print(f"\n📩 Code sent to your Telegram app for {phone}!")
    code = input("Enter the 5-digit verification code: ").strip().replace(" ", "").replace("-", "")
    
    try:
        await app.sign_in(phone, sent_code.phone_code_hash, code)
    except SessionPasswordNeeded:
        pwd = input("Two-Step Verification password (2FA): ").strip()
        try:
            await app.check_password(pwd)
        except PasswordHashInvalid:
            print("❌ Invalid 2FA password.")
            await app.disconnect()
            sys.exit(1)
    except PhoneCodeInvalid:
        print("❌ Invalid verification code.")
        await app.disconnect()
        sys.exit(1)
    except Exception as e:
        print(f"❌ Login failed: {e}")
        await app.disconnect()
        sys.exit(1)
        
    me = await app.get_me()
    print(f"\n✅ Logged in successfully as: {me.first_name} (@{me.username or me.id})")
    
    session_string = await app.export_session_string()
    update_env("STREAM_SESSION_STRING", session_string)
    print("\n💾 Saved STREAM_SESSION_STRING to .env!")
    await app.disconnect()
    
    restart_worker()
    print("🎉 Done! The assistant is now connected and ready for group voice/video calls.")

def main():
    parser = argparse.ArgumentParser(description="Pappy/Omega Assistant Session Tool")
    subparsers = parser.add_subparsers(dest="subcommand")
    
    # send-code
    p_send = subparsers.add_parser("send-code", help="Send login OTP to phone number")
    p_send.add_argument("phone", help="Phone number with country code (e.g. +1234567890)")
    
    # verify-code
    p_verify = subparsers.add_parser("verify-code", help="Verify OTP and export session")
    p_verify.add_argument("code", help="5-digit Telegram code")
    p_verify.add_argument("--password", "-p", default=None, help="2FA Cloud Password (if enabled)")
    
    # set-string
    p_set = subparsers.add_parser("set-string", help="Validate and save an existing session string")
    p_set.add_argument("session_str", help="Pyrogram session string")
    
    # test
    subparsers.add_parser("test", help="Test currently configured STREAM_SESSION_STRING")
    
    args = parser.parse_args()
    
    if args.subcommand == "send-code":
        asyncio.run(cmd_send_code(args.phone))
    elif args.subcommand == "verify-code":
        asyncio.run(cmd_verify_code(args.code, args.password))
    elif args.subcommand == "set-string":
        asyncio.run(cmd_set_string(args.session_str))
    elif args.subcommand == "test":
        asyncio.run(cmd_test())
    else:
        asyncio.run(cmd_interactive())

if __name__ == "__main__":
    main()
