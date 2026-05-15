"""
╔══════════════════════════════════════════════════════════╗
║           buscar_gram – Telegram Search Tool            ║
║  Dashboard TUI + busca real + exportação de resultados  ║
╚══════════════════════════════════════════════════════════╝

Dependências:
    pip install telethon python-dotenv

Uso:
    python buscar_gram.py
    python buscar_gram.py --query "checker" --limit 200
    python buscar_gram.py --query "palavra" --export resultados.txt
    python buscar_gram.py -q "palavra" -e saida.json
    python buscar_gram.py -q "palavra" --only groups
    python buscar_gram.py -q "palavra" --only all

Correção importante desta versão:
    Todas as chamadas do Telethon rodam na MESMA thread em que o cliente foi
    conectado. O dashboard roda em thread separada. Isso evita o erro:
    "The asyncio event loop must not change after connection".
"""

import os
import sys
import time
import csv
import json
import re
import shutil
import threading
import argparse
from datetime import datetime
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    from telethon.sync import TelegramClient
    from telethon import errors
    from telethon.tl.types import Channel, Chat, User
    _HAS_TELETHON = True
except ImportError:
    _HAS_TELETHON = False

# ══════════════════════════════════════════════════════════════════════════════
# Terminal / ANSI
# ══════════════════════════════════════════════════════════════════════════════

def enable_windows_ansi():
    if os.name != "nt":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


def get_term():
    s = shutil.get_terminal_size(fallback=(140, 40))
    return s.columns, s.lines


class C:
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    GRAY   = "\033[90m"
    WHITE  = "\033[97m"
    GREEN  = "\033[92m"
    RED    = "\033[91m"
    YELLOW = "\033[93m"

    @staticmethod
    def fg(n):
        return f"\033[38;5;{n}m"

    @staticmethod
    def bg(n):
        return f"\033[48;5;{n}m"


TEAL   = C.fg(51)
NEON   = C.fg(46)
LBLUE  = C.fg(75)
ORANGE = C.fg(214)
PURPLE = C.fg(135)
PINK   = C.fg(205)
BG_HDR = C.bg(18)
BG_PNL = C.bg(235)
BG_BAR = C.bg(17)
BG_ALT = C.bg(234)
BG_ROW = C.bg(233)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def ansi_len(s):
    return len(re.sub(r"\033\[[0-9;]*m", "", s))


def pad_ansi(s, width, fill=" "):
    return s + fill * max(0, width - ansi_len(s))


def spark_bar(value, total, width=40):
    pct = 0.0 if total == 0 else clamp(value / total, 0.0, 1.0)
    filled = int(pct * width)
    grad = [C.fg(c) for c in [27, 33, 39, 45, 51]]
    bar = ""
    for i in range(width):
        if i < filled:
            ci = clamp(int(i / max(filled, 1) * (len(grad) - 1)), 0, len(grad) - 1)
            bar += grad[ci] + "█"
        else:
            bar += C.fg(237) + "░"
    return bar + C.RESET


def clear_screen():
    os.system("cls" if os.name == "nt" else "clear")


def hide_cursor():
    sys.stdout.write("\033[?25l")
    sys.stdout.flush()


def show_cursor():
    sys.stdout.write("\033[?25h")
    sys.stdout.flush()


# ══════════════════════════════════════════════════════════════════════════════
# Estado global
# ══════════════════════════════════════════════════════════════════════════════

class State:
    def __init__(self):
        self.username = "—"
        self.query = ""
        self.limit = 500
        self.scope = "groups"
        self.start_time = time.time()
        self.chats = []
        self.results = []
        self.log = []
        self.done = False
        self.error = None
        self.stop_requested = False
        self._lock = threading.RLock()

    def add_log(self, msg, color=None):
        ts = datetime.now().strftime("%H:%M:%S")
        col = color or C.fg(244)
        with self._lock:
            self.log.append(f"{C.GRAY}[{ts}]{C.RESET} {col}{msg}{C.RESET}")
            self.log = self.log[-500:]

    def upsert_chat(self, name, found=0, total=0, elapsed=0, status="running"):
        with self._lock:
            for c in self.chats:
                if c["name"] == name:
                    c.update(found=found, total=total, elapsed=elapsed, status=status)
                    return
            self.chats.append({
                "name": name,
                "found": found,
                "total": total,
                "elapsed": elapsed,
                "status": status,
            })

    @property
    def total_found(self):
        with self._lock:
            return sum(c["found"] for c in self.chats)

    @property
    def total_msgs(self):
        with self._lock:
            return sum(c["total"] for c in self.chats)


STATE = State()


# ══════════════════════════════════════════════════════════════════════════════
# Dashboard
# ══════════════════════════════════════════════════════════════════════════════

def render(W, H):
    W = max(80, W)
    H = max(24, H)
    lines = []
    BAR_W = clamp(W - 58, 18, 60)

    with STATE._lock:
        username = STATE.username
        query = STATE.query
        limit = STATE.limit
        scope = STATE.scope
        done = STATE.done
        error = STATE.error
        chats_snap = list(STATE.chats)
        log_snap = list(STATE.log)
        total_found = STATE.total_found
        total_msgs = STATE.total_msgs

    elapsed_total = int(time.time() - STATE.start_time)
    ts = datetime.now().strftime("%H:%M:%S")

    lines.append(f"{BG_HDR}{TEAL}{'═' * W}{C.RESET}")
    title_vis = "◈ buscar_gram  ─  Telegram Search  ─  v5.1"
    right_vis = f"{ts}  ⬆ {elapsed_total:03d}s "
    pad_mid = max(0, W - len(title_vis) - len(right_vis) - 2)
    lines.append(
        f"{BG_HDR} {TEAL}{C.BOLD}◈ buscar_gram{C.RESET}{BG_HDR}  "
        f"{C.fg(244)}─{C.RESET}{BG_HDR}  {LBLUE}Telegram Search{C.RESET}{BG_HDR}  "
        f"{C.fg(244)}─{C.RESET}{BG_HDR}  {C.fg(240)}v5.1{C.RESET}"
        f"{BG_HDR}{' ' * pad_mid}{C.fg(244)}{ts}  ⬆ {elapsed_total:03d}s{C.RESET}{BG_HDR} {C.RESET}"
    )
    lines.append(f"{BG_HDR}{'─' * W}{C.RESET}")

    dim_info = f"  cols={W} lines={H}"
    pad_conn = max(0, W - 16 - len(username) - len(dim_info))
    lines.append(
        f"{BG_PNL} {C.fg(244)}Conectado como{C.RESET}{BG_PNL} "
        f"{TEAL}{C.BOLD}{username}{C.RESET}{BG_PNL}{'─' * pad_conn}"
        f"{C.fg(240)}{dim_info} {C.RESET}"
    )

    status_txt = f"{C.RED}✘ erro{C.RESET}" if error else (f"{NEON}✔ concluído{C.RESET}" if done else f"{ORANGE}⟳ buscando…{C.RESET}")
    query_str = query or "—"
    pad_search = max(0, W - 46 - len(query_str) - len(scope))
    lines.append(
        f"{BG_PNL} {ORANGE}🔍 Busca:{C.RESET}{BG_PNL} "
        f"{TEAL}{C.BOLD}\"{query_str}\"{C.RESET}{BG_PNL}  "
        f"{C.fg(244)}limite:{C.RESET}{BG_PNL} {LBLUE}{limit}{C.RESET}{BG_PNL}  "
        f"{C.fg(244)}escopo:{C.RESET}{BG_PNL} {PURPLE}{scope}{C.RESET}{BG_PNL}"
        f"{'─' * pad_search}{status_txt}{BG_PNL} {C.RESET}"
    )
    lines.append(f"{C.fg(237)}{'─' * W}{C.RESET}")

    pct = int(total_found / max(total_msgs, 1) * 100)
    stats = [
        (TEAL, "ENCONTRADO", f"{total_found:,}"),
        (ORANGE, "VARRIDAS", f"{total_msgs:,}"),
        (NEON, "CHATS", str(len(chats_snap))),
        (PURPLE, "MATCH RATE", f"{pct}%"),
    ]
    col_w = W // len(stats)
    stat_row = ""
    for color, label, val in stats:
        cell = f"{BG_PNL} {color}{C.BOLD}{val:<8}{C.RESET}{BG_PNL} {C.fg(244)}{label}{C.RESET}{BG_PNL}"
        stat_row += pad_ansi(cell, col_w)
    lines.append(stat_row[:W + 60])
    lines.append(f"{C.fg(237)}{'═' * W}{C.RESET}")

    hdr = (
        f"{BG_BAR}{LBLUE}{C.BOLD}"
        f"  {'CHAT':<28}  {'PROGRESSO':<{BAR_W+2}}  {'RESULTADO':>10}  {'%':>4}  {'TEMPO':>6}  {'STATUS':<10}"
        f"{C.RESET}"
    )
    lines.append(hdr)
    lines.append(f"{C.fg(238)}{'─' * W}{C.RESET}")

    STATUS_ICON = {
        "done": f"{NEON}✔ done   {C.RESET}",
        "running": f"{ORANGE}⟳ running{C.RESET}",
        "error": f"{C.RED}✘ error  {C.RESET}",
        "skip": f"{C.fg(244)}· skip   {C.RESET}",
        "pending": f"{C.fg(244)}· pending{C.RESET}",
    }

    max_table_rows = max(1, H - 17)
    for i, chat in enumerate(chats_snap[-max_table_rows:]):
        bar = spark_bar(chat["found"], chat["total"], width=BAR_W)
        cp = int(chat["found"] / max(chat["total"], 1) * 100)
        mins = int(chat["elapsed"] // 60)
        secs = int(chat["elapsed"] % 60)
        icon = STATUS_ICON.get(chat["status"], "")
        bg = BG_ALT if i % 2 == 0 else BG_ROW
        result_s = f"{LBLUE}{chat['found']:>4}{C.fg(244)}/{chat['total']:<4}{C.RESET}"
        row = (
            f"{bg} {TEAL}{C.BOLD}{chat['name'][:28]:<28}{C.RESET}{bg}  "
            f"{bar}  {result_s}{bg}  {C.fg(244)}{cp:>3}%{C.RESET}{bg}  "
            f"{C.fg(244)}{mins}:{secs:02d}{C.RESET}{bg}  {icon}"
        )
        lines.append(row)

    if not chats_snap:
        lines.append(f"{BG_ROW}  {C.fg(244)}Aguardando início da busca…{C.RESET}")

    lines.append(f"{C.fg(237)}{'─' * W}{C.RESET}")

    used = len(lines) + 3
    log_rows = max(2, H - used)
    lines.append(f"{BG_PNL}{LBLUE}{C.BOLD}  ▸ LOG{C.RESET}{BG_PNL}{C.fg(238)}{'─' * max(0, W - 7)}{C.RESET}")
    for entry in log_snap[-log_rows:]:
        lines.append(f"{BG_PNL}  {entry}{' ' * max(0, W - 2 - ansi_len(entry))}{C.RESET}")
    for _ in range(log_rows - len(log_snap[-log_rows:])):
        lines.append(f"{BG_PNL}{' ' * W}{C.RESET}")

    keys = "  [Ctrl+C] Sair   [exporta no final se usar -e]"
    brand = "buscar_gram © 2026  "
    pad_foot = max(0, W - len(keys) - len(brand))
    lines.append(f"{BG_HDR}{C.fg(244)}{keys}{'─' * pad_foot}{brand}{C.RESET}")

    clear_screen()
    hide_cursor()
    sys.stdout.write("\n".join(lines[:H]))
    sys.stdout.flush()


def dashboard_loop():
    while not STATE.done and not STATE.stop_requested:
        W, H = get_term()
        render(W, H)
        time.sleep(0.8)
    W, H = get_term()
    render(W, H)


# ══════════════════════════════════════════════════════════════════════════════
# Telegram helpers
# ══════════════════════════════════════════════════════════════════════════════

def safe_entity_name(dialog):
    name = getattr(dialog, "name", None) or str(getattr(dialog, "id", "?"))
    return str(name).replace("\n", " ")[:28]


def get_sender_name(msg):
    try:
        sender = msg.sender
        if sender is None:
            return "?"
        username = getattr(sender, "username", None)
        if username:
            return username
        first = getattr(sender, "first_name", None) or ""
        last = getattr(sender, "last_name", None) or ""
        name = (first + " " + last).strip()
        return name if name else str(getattr(sender, "id", "?"))
    except Exception:
        return "?"


def dialog_kind(dialog):
    entity = dialog.entity
    if isinstance(entity, User):
        return "self" if getattr(dialog, "is_self", False) else "dm"
    if isinstance(entity, Chat):
        return "group"
    if isinstance(entity, Channel):
        if getattr(entity, "broadcast", False):
            return "channel"
        return "group"
    return "other"


def should_scan_dialog(dialog, only, include_dms):
    kind = dialog_kind(dialog)
    if kind == "self":
        return False
    if only == "all":
        return kind in {"dm", "group", "channel", "other"}
    if only == "dms":
        return kind == "dm"
    if only == "groups":
        return kind == "group" or (include_dms and kind == "dm")
    if only == "channels":
        return kind == "channel" or (include_dms and kind == "dm")
    return kind in {"group", "channel"}


# ══════════════════════════════════════════════════════════════════════════════
# Busca e exportação
# ══════════════════════════════════════════════════════════════════════════════

def run_search(client, query, limit, export_path=None, only="groups", include_dms=False):
    STATE.add_log("Carregando lista de diálogos…", LBLUE)
    try:
        dialogs = client.get_dialogs(limit=None)
    except Exception as e:
        STATE.error = str(e)
        STATE.add_log(f"Erro ao carregar diálogos: {e}", C.RED)
        STATE.done = True
        return

    scan_dialogs = [d for d in dialogs if should_scan_dialog(d, only, include_dms)]
    STATE.add_log(f"{NEON}{len(dialogs)}{C.RESET} diálogos totais | {NEON}{len(scan_dialogs)}{C.RESET} no escopo", NEON)

    all_results = []

    for dialog in scan_dialogs:
        if STATE.stop_requested:
            break

        entity = dialog.entity
        name = safe_entity_name(dialog)
        kind = dialog_kind(dialog)

        STATE.upsert_chat(name, found=0, total=0, elapsed=0, status="running")
        STATE.add_log(f"Buscando em {TEAL}{name}{C.RESET} ({kind})…")

        t0 = time.time()
        found = []
        total = 0

        try:
            for msg in client.iter_messages(entity, search=query, limit=limit):
                if STATE.stop_requested:
                    break

                total += 1
                text = getattr(msg, "text", None) or getattr(msg, "message", None) or ""

                if text:
                    item = {
                        "chat": name,
                        "kind": kind,
                        "id": msg.id,
                        "date": msg.date.strftime("%Y-%m-%d %H:%M:%S") if msg.date else "",
                        "sender": get_sender_name(msg),
                        "text": text[:1000],
                    }
                    found.append(item)

                elapsed = int(time.time() - t0)
                if total % 5 == 0 or text:
                    STATE.upsert_chat(name, found=len(found), total=total, elapsed=elapsed, status="running")

        except errors.FloodWaitError as e:
            wait = int(getattr(e, "seconds", 30))
            STATE.add_log(f"FloodWait {wait}s em {name}. Pulando para não travar o rolê.", ORANGE)
            STATE.upsert_chat(name, found=len(found), total=total, elapsed=int(time.time() - t0), status="error")
            all_results.extend(found)
            continue

        except errors.ChannelPrivateError:
            STATE.add_log(f"Canal/grupo privado sem acesso: {name}", ORANGE)
            STATE.upsert_chat(name, found=len(found), total=total, elapsed=int(time.time() - t0), status="error")
            all_results.extend(found)
            continue

        except Exception as e:
            STATE.add_log(f"Erro em {name}: {e}", C.RED)
            STATE.upsert_chat(name, found=len(found), total=total, elapsed=int(time.time() - t0), status="error")
            all_results.extend(found)
            continue

        elapsed = int(time.time() - t0)
        STATE.upsert_chat(name, found=len(found), total=total, elapsed=elapsed, status="done")
        all_results.extend(found)

        if found:
            STATE.add_log(f"{NEON}{len(found)}{C.RESET} resultado(s) em {TEAL}{name}{C.RESET} ({elapsed}s)")

    with STATE._lock:
        STATE.results = all_results

    STATE.add_log(f"Busca concluída — {NEON}{len(all_results)}{C.RESET} mensagem(ns) encontrada(s)", NEON)

    if export_path:
        export_results(all_results, export_path)

    STATE.done = True


def export_results(results, path):
    p = Path(path)
    STATE.add_log(f"Exportando {len(results)} resultado(s) → {path}…", LBLUE)
    try:
        if p.suffix.lower() == ".json":
            with open(p, "w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
        elif p.suffix.lower() == ".csv":
            with open(p, "w", encoding="utf-8-sig", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=["date", "chat", "kind", "sender", "id", "text"])
                writer.writeheader()
                writer.writerows(results)
        else:
            with open(p, "w", encoding="utf-8") as f:
                f.write(f'buscar_gram – resultados para "{STATE.query}"\n')
                f.write(f"Exportado em: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write("═" * 80 + "\n\n")
                for r in results:
                    f.write(f"[{r.get('date', '')}] {r.get('chat', '')} ({r.get('kind', '')}) @{r.get('sender', '')} #{r.get('id', '')}\n")
                    f.write(f"{r.get('text', '')}\n")
                    f.write("─" * 60 + "\n")
        STATE.add_log(f"Exportação concluída → {path}", NEON)
    except Exception as e:
        STATE.add_log(f"Erro na exportação: {e}", C.RED)


# ══════════════════════════════════════════════════════════════════════════════
# Configuração
# ══════════════════════════════════════════════════════════════════════════════

def resolve_credentials():
    env_id = os.environ.get("API_ID", "").strip()
    env_hash = os.environ.get("API_HASH", "").strip()

    if env_id and env_hash:
        try:
            return int(env_id), env_hash
        except ValueError:
            print(f"{C.RED}API_ID no .env precisa ser número. Exemplo: API_ID=123456{C.RESET}")
            sys.exit(1)

    show_cursor()
    print(f"\n{TEAL}{C.BOLD}buscar_gram – configuração inicial{C.RESET}")
    print(f"{C.fg(244)}Obtenha suas credenciais em: https://my.telegram.org/apps{C.RESET}\n")
    try:
        api_id = int(input(f"{LBLUE}API_ID  : {C.RESET}").strip())
        api_hash = input(f"{LBLUE}API_HASH: {C.RESET}").strip()
    except (ValueError, EOFError):
        print(f"{C.RED}Credenciais inválidas. Encerrando.{C.RESET}")
        sys.exit(1)
    return api_id, api_hash


def parse_args():
    p = argparse.ArgumentParser(description="buscar_gram – busca mensagens no Telegram")
    p.add_argument("--query", "-q", default="", help="Texto a buscar")
    p.add_argument("--limit", "-l", default=500, type=int, help="Limite de mensagens por diálogo")
    p.add_argument("--export", "-e", default="", help="Arquivo de saída: .txt, .json ou .csv")
    p.add_argument("--session", "-s", default=os.environ.get("SESSION_NAME", "buscar_gram_session"), help="Nome/arquivo da sessão Telethon")
    p.add_argument("--dms", action="store_true", help="Incluir DMs junto do escopo escolhido")
    p.add_argument("--only", choices=["groups", "channels", "dms", "all"], default="groups", help="Escopo da busca")
    return p.parse_args()


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    enable_windows_ansi()

    if os.name == "nt":
        try:
            os.system("mode con: cols=140 lines=40")
        except Exception:
            pass

    args = parse_args()

    if not _HAS_TELETHON:
        print(f"{C.RED}Telethon não encontrado.{C.RESET}")
        print("  pip install telethon python-dotenv")
        sys.exit(1)

    api_id, api_hash = resolve_credentials()

    query = args.query.strip()
    if not query:
        show_cursor()
        query = input(f"\n{LBLUE}Texto a buscar: {C.RESET}").strip()
        if not query:
            print(f"{C.RED}Query vazia. Encerrando.{C.RESET}")
            sys.exit(1)

    STATE.query = query
    STATE.limit = args.limit
    STATE.scope = args.only if not args.dms else f"{args.only}+dms"
    STATE.start_time = time.time()
    STATE.add_log("Iniciando buscar_gram…", TEAL)

    client = TelegramClient(args.session, api_id, api_hash)

    try:
        # Tudo do Telethon acontece na main thread. Nada de cliente pulando de loop.
        client.start()
        me = client.get_me()
        STATE.username = (getattr(me, "username", None) or getattr(me, "first_name", None) or "desconhecido") if me else "desconhecido"
        STATE.add_log(f"Conectado como {TEAL}{STATE.username}{C.RESET}", NEON)
        STATE.add_log(f"Query: {TEAL}\"{query}\"{C.RESET} | Limite: {LBLUE}{args.limit}{C.RESET} | Escopo: {PURPLE}{STATE.scope}{C.RESET}")

        dash = threading.Thread(target=dashboard_loop, daemon=True)
        dash.start()

        run_search(
            client=client,
            query=query,
            limit=args.limit,
            export_path=args.export or None,
            only=args.only,
            include_dms=args.dms,
        )

        dash.join(timeout=2)

    except KeyboardInterrupt:
        STATE.stop_requested = True
        STATE.done = True
        STATE.add_log("Interrompido pelo usuário.", ORANGE)
    except Exception as e:
        STATE.error = str(e)
        STATE.done = True
        STATE.add_log(f"Erro geral: {e}", C.RED)
    finally:
        try:
            client.disconnect()
        except Exception:
            pass

        time.sleep(0.3)
        show_cursor()
        clear_screen()

        tf = STATE.total_found
        print(f"\n{TEAL}{C.BOLD}buscar_gram encerrado.{C.RESET}  Resultados: {NEON}{tf}{C.RESET}\n")

        # --- Exibe TODOS os resultados encontrados no terminal ---
        if STATE.results:
            W, _ = get_term()
            W = max(80, W)
            print(f"{TEAL}{'═' * W}{C.RESET}")
            print(f"{TEAL}{C.BOLD}  RESULTADOS ENCONTRADOS  {C.fg(244)}({tf} mensagens){C.RESET}")
            print(f"{TEAL}{'═' * W}{C.RESET}\n")

            for i, r in enumerate(STATE.results, start=1):
                date = r.get('date', '')
                chat = r.get('chat', '')
                kind = r.get('kind', '')
                sender = r.get('sender', '?')
                msg_id = r.get('id', '')
                text = (r.get('text', '') or '').strip()

                head = (
                    f"{C.fg(244)}#{i:>5}  "
                    f"{LBLUE}[{date}]{C.RESET}  "
                    f"{TEAL}{C.BOLD}{chat}{C.RESET}  "
                    f"{PURPLE}({kind}){C.RESET}  "
                    f"{ORANGE}@{sender}{C.RESET}  "
                    f"{C.fg(244)}#{msg_id}{C.RESET}"
                )
                print(head)
                for line in text.splitlines() or [""]:
                    print(f"        {C.WHITE}{line}{C.RESET}")
                print(f"{C.fg(238)}{'─' * W}{C.RESET}")

            print(f"\n{NEON}{C.BOLD}Total: {tf} resultado(s){C.RESET}")
            if args.export:
                print(f"{C.fg(244)}Arquivo salvo em:{C.RESET} {NEON}{args.export}{C.RESET}\n")
        # --- fim da listagem ---

        if STATE.error:
            print(f"{C.RED}Erro: {STATE.error}{C.RESET}\n")

        if STATE.results and not args.export:
            try:
                save = input(f"{LBLUE}Exportar {tf} resultado(s)? Ex: resultados.txt/json/csv — Enter para pular: {C.RESET}").strip()
                if save:
                    export_results(STATE.results, save)
                    print(f"{NEON}Salvo em {save}{C.RESET}\n")
            except KeyboardInterrupt:
                print()


if __name__ == "__main__":
    main()
