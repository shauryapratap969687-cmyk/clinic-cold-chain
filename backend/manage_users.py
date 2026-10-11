"""Local administrator CLI: no passwords accepted in command-line arguments."""
import argparse
from getpass import getpass
import sqlite3


def main() -> None:
    parser = argparse.ArgumentParser(description="Provision or disable a cold-chain account locally")
    parser.add_argument("--env-file", help="Private environment file also used by the server")
    commands = parser.add_subparsers(dest="action", required=True)
    create = commands.add_parser("create")
    create.add_argument("username")
    create.add_argument("--role", required=True, choices=["admin", "clinic_operator", "grid_operator", "auditor"])
    disable = commands.add_parser("disable")
    disable.add_argument("username")
    args = parser.parse_args()
    if args.env_file:
        from dotenv import load_dotenv
        if not load_dotenv(args.env_file, override=False):
            parser.error("Environment file is missing or empty")
    # Configuration is loaded only AFTER the explicitly requested private file.
    from . import config
    from .auth import hash_password
    from .storage import Storage, utc_now
    config.validate()
    username = args.username.strip()
    if not username or len(username) > 128:
        parser.error("Username must contain 1..128 characters")
    store = Storage()
    if args.action == "create":
        password = getpass("New password (12+ characters): ")
        if len(password) < 12 or len(password) > 256:
            parser.error("Password must contain 12..256 characters")
        if password != getpass("Confirm password: "):
            parser.error("Passwords did not match")
        try:
            with store._connect() as db:
                db.execute("INSERT INTO users(username,password_hash,role,active,created_at) VALUES(?,?,?,1,?)",
                           (username, hash_password(password), args.role, utc_now()))
        except sqlite3.IntegrityError:
            parser.error("Username already exists; no account was overwritten")
        store.audit("user.create", "local-admin-cli", username, {"role": args.role})
    else:
        with store._connect() as db:
            if not db.execute("UPDATE users SET active=0 WHERE username=?", (username,)).rowcount:
                parser.error("Username does not exist")
        store.audit("user.disable", "local-admin-cli", username)
    print(f"Account {username}: {args.action} completed. No password was logged.")


if __name__ == "__main__":
    main()
