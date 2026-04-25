import customtkinter as ctk
import threading
import calendar
from datetime import datetime, date


# ─────────────────────────── Add / Edit Server Modal ────────────────────────
class AddServerModal(ctk.CTkToplevel):
    def __init__(self, master, on_save_callback, sql_agent_module):
        super().__init__(master)
        self.title("Add SQL Server")
        self.geometry("420x560")
        self.resizable(False, False)
        self.attributes("-topmost", True)
        self.on_save_callback = on_save_callback
        self.sql_agent = sql_agent_module

        self.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(self, text="Server Configuration",
                     font=ctk.CTkFont(size=18, weight="bold")).grid(row=0, column=0, pady=(24, 4))
        ctk.CTkLabel(self, text="Connect to a SQL Server Agent instance",
                     font=ctk.CTkFont(size=12), text_color="gray").grid(row=1, column=0, pady=(0, 16))

        self.alias_entry = ctk.CTkEntry(self, placeholder_text="Server Alias (e.g. Production DB)", width=320)
        self.alias_entry.grid(row=2, column=0, pady=6)

        self.address_entry = ctk.CTkEntry(self, placeholder_text="Server Address / IP", width=320)
        self.address_entry.grid(row=3, column=0, pady=6)

        self.instance_entry = ctk.CTkEntry(self, placeholder_text="Instance (optional, e.g. SQLEXPRESS)", width=320)
        self.instance_entry.grid(row=4, column=0, pady=6)

        self.user_entry = ctk.CTkEntry(self, placeholder_text="Username (leave blank for Windows Auth)", width=320)
        self.user_entry.grid(row=5, column=0, pady=6)

        self.pass_entry = ctk.CTkEntry(self, placeholder_text="Password", show="*", width=320)
        self.pass_entry.grid(row=6, column=0, pady=6)

        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.grid(row=7, column=0, pady=20)

        self.test_btn = ctk.CTkButton(btn_frame, text="Test Connection", width=140,
                                      fg_color="transparent", border_width=1,
                                      border_color="#6366f1", text_color="#6366f1",
                                      hover_color="#6366f1",
                                      command=self._test_connection)
        self.test_btn.pack(side="left", padx=6)

        self.save_btn = ctk.CTkButton(btn_frame, text="Save Server", width=140,
                                      fg_color="#4f46e5", hover_color="#4338ca",
                                      command=self._save_clicked)
        self.save_btn.pack(side="left", padx=6)

        self.msg_label = ctk.CTkLabel(self, text="", font=ctk.CTkFont(size=12))
        self.msg_label.grid(row=8, column=0)

    def _build_server_dict(self):
        return {
            "alias": self.alias_entry.get().strip(),
            "address": self.address_entry.get().strip(),
            "instance": self.instance_entry.get().strip(),
            "user": self.user_entry.get().strip(),
            "password": self.pass_entry.get().strip(),
        }

    def _test_connection(self):
        data = self._build_server_dict()
        if not data["alias"] or not data["address"]:
            self._set_msg("Alias and Address are required!", "#ef4444")
            return
        self.test_btn.configure(state="disabled", text="Testing...")
        self._set_msg("Connecting...", "gray")

        def run():
            ok, msg = self.sql_agent.test_connection(data)
            self.after(0, lambda: self._test_done(ok, msg))

        threading.Thread(target=run, daemon=True).start()

    def _test_done(self, ok, msg):
        self.test_btn.configure(state="normal", text="Test Connection")
        if ok:
            self._set_msg("✓  " + msg, "#10b981")
        else:
            self._set_msg("✗  " + msg[:80], "#ef4444")

    def _save_clicked(self):
        data = self._build_server_dict()
        if not data["alias"] or not data["address"]:
            self._set_msg("Alias and Address are required!", "#ef4444")
            return
        self.on_save_callback(data)
        self.destroy()

    def _set_msg(self, text, color="gray"):
        self.msg_label.configure(text=text, text_color=color)


# ─────────────────────────── Confirm Dialog ──────────────────────────────────
class ConfirmDialog(ctk.CTkToplevel):
    """
    Modal confirmation dialog.
    on_confirm callback is called if the user clicks Confirm.
    on_cancel callback (optional) is called if the user cancels.
    """
    def __init__(self, master, title, message, on_confirm, on_cancel=None,
                 confirm_text="Confirm", confirm_color="#4f46e5"):
        super().__init__(master)
        self.title(title)
        self.resizable(False, False)
        self.attributes("-topmost", True)
        self.on_confirm = on_confirm
        self.on_cancel = on_cancel

        self.grid_columnconfigure(0, weight=1)

        # Icon + title
        ctk.CTkLabel(self, text="⚠", font=ctk.CTkFont(size=32),
                     text_color="#f59e0b").grid(row=0, column=0, pady=(28, 4))
        ctk.CTkLabel(self, text=title,
                     font=ctk.CTkFont(size=16, weight="bold")).grid(row=1, column=0, padx=30)
        ctk.CTkLabel(self, text=message, font=ctk.CTkFont(size=13),
                     text_color="gray", wraplength=320,
                     justify="center").grid(row=2, column=0, padx=30, pady=(8, 20))

        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.grid(row=3, column=0, pady=(0, 24))

        ctk.CTkButton(btn_frame, text="Cancel", width=120,
                      fg_color="transparent", border_width=1,
                      border_color="#6b7280", text_color="#9ca3af",
                      hover_color=('#e2e8f0', '#1e2030'),
                      command=self._cancel).pack(side="left", padx=8)

        ctk.CTkButton(btn_frame, text=confirm_text, width=120,
                      fg_color=confirm_color,
                      hover_color="#4338ca",
                      command=self._confirm).pack(side="left", padx=8)

        # Size after widgets placed
        self.update_idletasks()
        self.geometry(f"380x{self.winfo_reqheight()}")
        # Center on parent
        self.after(10, self._center)

    def _center(self):
        master = self.master
        x = master.winfo_x() + (master.winfo_width() - self.winfo_width()) // 2
        y = master.winfo_y() + (master.winfo_height() - self.winfo_height()) // 2
        self.geometry(f"+{x}+{y}")

    def _confirm(self):
        self.destroy()
        self.on_confirm()

    def _cancel(self):
        self.destroy()
        if self.on_cancel:
            self.on_cancel()


# ─────────────────────────── Stats Bar ──────────────────────────────────────
class StatsBar(ctk.CTkFrame):
    def __init__(self, master):
        super().__init__(master, fg_color=('#e2e8f0', '#1e2030'), corner_radius=10)
        self.grid_columnconfigure((0, 1, 2, 3), weight=1)
        self._labels = {}
        specs = [
            ("total",     "Total Jobs",    ('#111827', 'white')),
            ("succeeded", "Succeeded",     "#10b981"),
            ("failed",    "Failed",        "#ef4444"),
            ("disabled",  "Disabled",      "#9ca3af"),
        ]
        for col, (key, title, color) in enumerate(specs):
            card = ctk.CTkFrame(self, fg_color="transparent")
            card.grid(row=0, column=col, padx=20, pady=12, sticky="w")
            val_lbl = ctk.CTkLabel(card, text="—", font=ctk.CTkFont(size=26, weight="bold"), text_color=color)
            val_lbl.pack(anchor="w")
            ctk.CTkLabel(card, text=title, font=ctk.CTkFont(size=11), text_color="gray").pack(anchor="w")
            self._labels[key] = val_lbl

    def update(self, jobs):
        total = len(jobs)
        succeeded = sum(1 for j in jobs if j["last_run_status"] == "Succeeded")
        failed = sum(1 for j in jobs if j["last_run_status"] == "Failed")
        disabled = sum(1 for j in jobs if not j["enabled"])
        self._labels["total"].configure(text=str(total))
        self._labels["succeeded"].configure(text=str(succeeded))
        self._labels["failed"].configure(text=str(failed))
        self._labels["disabled"].configure(text=str(disabled))

    def reset(self):
        for lbl in self._labels.values():
            lbl.configure(text="—")


# ─────────────────────────── Job History Modal ──────────────────────────────
class JobHistoryModal(ctk.CTkToplevel):
    def __init__(self, master, job_name, server, sql_agent_module):
        super().__init__(master)
        self.title(f"History — {job_name}")
        self.geometry("700x480")
        self.attributes("-topmost", True)
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)

        ctk.CTkLabel(self, text=f"Run History: {job_name}",
                     font=ctk.CTkFont(size=16, weight="bold")).grid(row=0, column=0, pady=(20, 10))

        self.scroll = ctk.CTkScrollableFrame(self, fg_color="transparent")
        self.scroll.grid(row=1, column=0, sticky="nsew", padx=20, pady=(0, 20))
        self.scroll.grid_columnconfigure((0, 1, 2), weight=1)
        self.scroll.grid_columnconfigure(3, weight=4)

        self._loading_lbl = ctk.CTkLabel(self.scroll, text="Loading history...", text_color="gray")
        self._loading_lbl.pack(pady=20)

        def fetch():
            ok, data = sql_agent_module.fetch_job_history(server, job_name)
            self.after(0, lambda: self._render(ok, data))

        threading.Thread(target=fetch, daemon=True).start()

    def _render(self, ok, data):
        self._loading_lbl.destroy()
        if not ok:
            ctk.CTkLabel(self.scroll, text=f"Error: {data}", text_color="#ef4444").pack(pady=10)
            return
        if not data:
            ctk.CTkLabel(self.scroll, text="No history found.", text_color="gray").pack(pady=20)
            return

        header_font = ctk.CTkFont(size=11, weight="bold")
        for col, text in enumerate(["Date / Time", "Status", "Duration", "Message"]):
            ctk.CTkLabel(self.scroll, text=text, font=header_font,
                         text_color="gray").grid(row=0, column=col, sticky="w", padx=8, pady=(0, 6))

        for row_idx, entry in enumerate(data, start=1):
            status = entry["status"]
            color = {"Succeeded": "#10b981", "Failed": "#ef4444",
                     "In Progress": "#f59e0b"}.get(status, "gray")

            dt_str = entry["run_datetime"].strftime("%Y-%m-%d %H:%M") if entry["run_datetime"] else "—"
            dur = entry["duration_seconds"]
            if dur is None:
                dur_str = "—"
            elif dur < 60:
                dur_str = f"{dur}s"
            else:
                dur_str = f"{dur//60}m {dur%60}s"

            msg = (entry["message"] or "").strip()

            ctk.CTkLabel(self.scroll, text=dt_str, font=ctk.CTkFont(size=12)).grid(row=row_idx, column=0, sticky="nw", padx=8, pady=6)
            ctk.CTkLabel(self.scroll, text=status, font=ctk.CTkFont(size=12, weight="bold"), text_color=color).grid(row=row_idx, column=1, sticky="nw", padx=8, pady=6)
            ctk.CTkLabel(self.scroll, text=dur_str, font=ctk.CTkFont(size=12)).grid(row=row_idx, column=2, sticky="nw", padx=8, pady=6)
            ctk.CTkLabel(self.scroll, text=msg, font=ctk.CTkFont(size=11), text_color="gray", justify="left", wraplength=400).grid(row=row_idx, column=3, sticky="nw", padx=8, pady=6)

            sep = ctk.CTkFrame(self.scroll, height=1, fg_color=('#cbd5e1', '#2a2a3d'))
            sep.grid(row=row_idx + 1000, column=0, columnspan=4, sticky="ew", pady=0)


# ─────────────────────────── Calendar View ──────────────────────────────────
class CalendarView(ctk.CTkToplevel):
    """
    Monthly calendar showing jobs scheduled on each day.
    schedules: dict  {job_name: [datetime, ...]}
    """
    DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    def __init__(self, master, schedules: dict):
        super().__init__(master)
        self.title("Job Schedule Calendar")
        self.geometry("860x580")
        self.resizable(True, True)
        self.attributes("-topmost", True)
        self.schedules = schedules  # {job_name: [datetime]}

        today = date.today()
        self._year = today.year
        self._month = today.month

        self.grid_rowconfigure(1, weight=1)
        self.grid_columnconfigure(0, weight=1)

        # ── Nav bar ──────────────────────────────────────────────
        nav = ctk.CTkFrame(self, fg_color="transparent")
        nav.grid(row=0, column=0, sticky="ew", padx=20, pady=(16, 6))
        nav.grid_columnconfigure(1, weight=1)

        self._prev_btn = ctk.CTkButton(nav, text="◀", width=36,
                                       fg_color=('#e2e8f0', '#1e2030'),
                                       hover_color="#4f46e5",
                                       command=self._prev_month)
        self._prev_btn.grid(row=0, column=0)

        self._month_lbl = ctk.CTkLabel(nav, text="",
                                       font=ctk.CTkFont(size=18, weight="bold"))
        self._month_lbl.grid(row=0, column=1)

        self._next_btn = ctk.CTkButton(nav, text="▶", width=36,
                                       fg_color=('#e2e8f0', '#1e2030'),
                                       hover_color="#4f46e5",
                                       command=self._next_month)
        self._next_btn.grid(row=0, column=2)

        # ── Calendar grid container ───────────────────────────────
        self._grid_frame = ctk.CTkFrame(self, fg_color="transparent")
        self._grid_frame.grid(row=1, column=0, sticky="nsew", padx=14, pady=(0, 14))
        for c in range(7):
            self._grid_frame.grid_columnconfigure(c, weight=1)

        self._render_calendar()

    # ── Build the day cells ──────────────────────────────────────
    def _render_calendar(self):
        for w in self._grid_frame.winfo_children():
            w.destroy()

        self._month_lbl.configure(
            text=f"{calendar.month_name[self._month]}  {self._year}")

        # Day-of-week headers
        for col, day in enumerate(self.DAYS):
            color = "#ef4444" if day == "Sun" else "#6b7280"
            ctk.CTkLabel(self._grid_frame, text=day,
                         font=ctk.CTkFont(size=11, weight="bold"),
                         text_color=color).grid(row=0, column=col, padx=4, pady=(4, 8))

        # Build schedule lookup: {date: [job_name, ...]}
        date_jobs: dict[date, list] = {}
        for job_name, datetimes in self.schedules.items():
            for dt in datetimes:
                d = dt.date() if hasattr(dt, "date") else dt
                date_jobs.setdefault(d, []).append(job_name)

        today = date.today()
        cal = calendar.monthcalendar(self._year, self._month)

        for row_idx, week in enumerate(cal, start=1):
            self._grid_frame.grid_rowconfigure(row_idx, weight=1)
            for col_idx, day_num in enumerate(week):
                if day_num == 0:
                    ctk.CTkFrame(self._grid_frame,
                                 fg_color="transparent").grid(row=row_idx, column=col_idx,
                                                              padx=3, pady=3, sticky="nsew")
                    continue

                d = date(self._year, self._month, day_num)
                is_today = (d == today)
                jobs_today = date_jobs.get(d, [])

                cell_color = ('#dbeafe', '#1e3a5f') if is_today else ('#f1f5f9', '#1a1c29')
                cell = ctk.CTkFrame(self._grid_frame,
                                    fg_color=cell_color, corner_radius=8)
                cell.grid(row=row_idx, column=col_idx, padx=3, pady=3, sticky="nsew")
                cell.grid_propagate(False)
                cell.configure(height=80)

                day_color = "#6366f1" if is_today else ('#111827', 'white')
                ctk.CTkLabel(cell, text=str(day_num),
                             font=ctk.CTkFont(size=13, weight="bold"),
                             text_color=day_color).pack(anchor="nw", padx=6, pady=(4, 0))

                if jobs_today:
                    count = len(jobs_today)
                    dot_text = f"● {jobs_today[0][:18]}" if count == 1 else f"● {jobs_today[0][:14]}…+{count-1}"
                    ctk.CTkLabel(cell, text=dot_text,
                                 font=ctk.CTkFont(size=9),
                                 text_color="#10b981",
                                 wraplength=100, justify="left").pack(anchor="nw", padx=6)

                if jobs_today:
                    cell.bind("<Button-1>", lambda e, jbs=jobs_today, day=d: self._show_day_popup(day, jbs))
                    for child in cell.winfo_children():
                        child.bind("<Button-1>", lambda e, jbs=jobs_today, day=d: self._show_day_popup(day, jbs))

    def _show_day_popup(self, day: date, jobs: list):
        popup = ctk.CTkToplevel(self)
        popup.title(f"Jobs on {day.strftime('%B %d, %Y')}")
        popup.geometry("420x300")
        popup.attributes("-topmost", True)
        popup.resizable(False, True)

        ctk.CTkLabel(popup, text=f"📅  {day.strftime('%B %d, %Y')}",
                     font=ctk.CTkFont(size=15, weight="bold")).pack(pady=(20, 8))

        scroll = ctk.CTkScrollableFrame(popup, fg_color="transparent")
        scroll.pack(fill="both", expand=True, padx=16, pady=(0, 16))

        for job in jobs:
            row = ctk.CTkFrame(scroll, fg_color=('#e2e8f0', '#1e2030'), corner_radius=6)
            row.pack(fill="x", pady=3, padx=4)
            ctk.CTkLabel(row, text=f"● {job}",
                         font=ctk.CTkFont(size=12),
                         text_color="#10b981",
                         anchor="w").pack(pady=8, padx=12, anchor="w")

    def _prev_month(self):
        if self._month == 1:
            self._month = 12
            self._year -= 1
        else:
            self._month -= 1
        self._render_calendar()

    def _next_month(self):
        if self._month == 12:
            self._month = 1
            self._year += 1
        else:
            self._month += 1
        self._render_calendar()


# ─────────────────────────── User Management Modal ──────────────────────────
class UserManagementModal(ctk.CTkToplevel):
    """Admin-only modal to list, add, change password, and delete users."""

    ROLES = ["admin", "ops", "user"]
    ROLE_COLORS = {"admin": "#6366f1", "ops": "#f59e0b", "user": "#10b981"}

    def __init__(self, master, database_module, current_user_id=None):
        super().__init__(master)
        self.title("User Management")
        self.geometry("600x540")
        self.resizable(False, True)
        self.attributes("-topmost", True)
        self.db = database_module
        self.current_user_id = current_user_id  # prevent self-delete

        self.grid_rowconfigure(1, weight=1)
        self.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(self, text="👤  User Management",
                     font=ctk.CTkFont(size=18, weight="bold")).grid(
            row=0, column=0, pady=(20, 8))

        # ── User list ─────────────────────────────────────────────
        self._list_frame = ctk.CTkScrollableFrame(self, fg_color="transparent")
        self._list_frame.grid(row=1, column=0, sticky="nsew", padx=20, pady=(0, 8))
        self._list_frame.grid_columnconfigure(0, weight=1)

        # ── Separator ─────────────────────────────────────────────
        ctk.CTkFrame(self, height=1, fg_color=('#cbd5e1', '#2a2a3d')).grid(
            row=2, column=0, sticky="ew", padx=20)

        # ── Add-user form ─────────────────────────────────────────
        add_frame = ctk.CTkFrame(self, fg_color="transparent")
        add_frame.grid(row=3, column=0, sticky="ew", padx=20, pady=12)
        add_frame.grid_columnconfigure((0, 1, 2), weight=1)

        ctk.CTkLabel(add_frame, text="Add New User",
                     font=ctk.CTkFont(size=13, weight="bold")).grid(
            row=0, column=0, columnspan=3, sticky="w", pady=(0, 6))

        self._new_user_var = ctk.StringVar()
        self._new_pass_var = ctk.StringVar()
        self._new_role_var = ctk.StringVar(value="user")

        ctk.CTkEntry(add_frame, textvariable=self._new_user_var,
                     placeholder_text="Username", width=160).grid(
            row=1, column=0, padx=(0, 6))
        ctk.CTkEntry(add_frame, textvariable=self._new_pass_var,
                     placeholder_text="Password", show="*", width=140).grid(
            row=1, column=1, padx=6)
        ctk.CTkOptionMenu(add_frame, values=self.ROLES,
                          variable=self._new_role_var, width=100).grid(
            row=1, column=2, padx=(6, 0))

        self._add_msg = ctk.CTkLabel(add_frame, text="", font=ctk.CTkFont(size=11))
        self._add_msg.grid(row=2, column=0, columnspan=3, sticky="w", pady=(4, 0))

        ctk.CTkButton(add_frame, text="+ Add User",
                      fg_color="#4f46e5", hover_color="#4338ca",
                      command=self._add_user).grid(
            row=3, column=0, columnspan=3, sticky="w", pady=(6, 0))

        self._refresh_list()

    # ── List rendering ────────────────────────────────────────────
    def _refresh_list(self):
        for w in self._list_frame.winfo_children():
            w.destroy()

        users = self.db.list_users()
        if not users:
            ctk.CTkLabel(self._list_frame, text="No users found.",
                         text_color="gray").pack(pady=10)
            return

        header_font = ctk.CTkFont(size=11, weight="bold")
        hf = ctk.CTkFrame(self._list_frame, fg_color="transparent")
        hf.pack(fill="x", pady=(0, 4))
        for col, txt, w in [("Username", 180), ("Role", 80), ("Actions", 180)]:
            ctk.CTkLabel(hf, text=col, font=header_font,
                         text_color="#6b7280", width=w, anchor="w").pack(side="left", padx=4)

        for u in users:
            self._user_row(u)

    def _user_row(self, u):
        row = ctk.CTkFrame(self._list_frame,
                           fg_color=('#f1f5f9', '#151728'), corner_radius=6)
        row.pack(fill="x", pady=2)

        ctk.CTkLabel(row, text=u["username"],
                     font=ctk.CTkFont(size=13), width=180, anchor="w").pack(
            side="left", padx=10, pady=8)

        role_color = self.ROLE_COLORS.get(u["role"], "gray")
        role_badge = ctk.CTkFrame(row, fg_color="transparent",
                                  border_width=1, border_color=role_color,
                                  corner_radius=5, width=70)
        role_badge.pack(side="left", padx=6)
        ctk.CTkLabel(role_badge, text=u["role"],
                     text_color=role_color,
                     font=ctk.CTkFont(size=11, weight="bold"),
                     padx=6, pady=2).pack()

        actions = ctk.CTkFrame(row, fg_color="transparent")
        actions.pack(side="right", padx=8)

        ctk.CTkButton(actions, text="🔑 Passwd", width=90, height=26,
                      fg_color="transparent", border_width=1,
                      border_color="#6b7280", text_color="#9ca3af",
                      hover_color=('#e2e8f0', '#1e2030'),
                      command=lambda uid=u["id"], uname=u["username"]: self._change_password(uid, uname)
                      ).pack(side="left", padx=2)

        is_self = (u["id"] == self.current_user_id)
        ctk.CTkButton(actions, text="✕", width=32, height=26,
                      fg_color="transparent", border_width=1,
                      border_color="#ef4444" if not is_self else "#374151",
                      text_color="#ef4444" if not is_self else "#374151",
                      hover_color="#7f1d1d" if not is_self else "transparent",
                      state="normal" if not is_self else "disabled",
                      command=lambda uid=u["id"], uname=u["username"]: self._delete_user(uid, uname)
                      ).pack(side="left", padx=2)

    # ── Actions ───────────────────────────────────────────────────
    def _add_user(self):
        uname = self._new_user_var.get().strip()
        pwd = self._new_pass_var.get()
        role = self._new_role_var.get()
        if not uname or not pwd:
            self._add_msg.configure(text="Username and password are required.", text_color="#ef4444")
            return
        ok, result = self.db.add_user(uname, pwd, role)
        if ok:
            self._new_user_var.set("")
            self._new_pass_var.set("")
            self._add_msg.configure(text=f"✓ User '{uname}' added.", text_color="#10b981")
            self._refresh_list()
        else:
            self._add_msg.configure(text=f"✗ {result}", text_color="#ef4444")

    def _change_password(self, user_id, username):
        dialog = ctk.CTkToplevel(self)
        dialog.title(f"Change Password — {username}")
        dialog.geometry("320x200")
        dialog.resizable(False, False)
        dialog.attributes("-topmost", True)

        ctk.CTkLabel(dialog, text=f"New password for  '{username}'",
                     font=ctk.CTkFont(size=13)).pack(pady=(24, 8))
        pwd_var = ctk.StringVar()
        ctk.CTkEntry(dialog, textvariable=pwd_var,
                     show="*", width=240,
                     placeholder_text="New password").pack(padx=20)
        msg_lbl = ctk.CTkLabel(dialog, text="", font=ctk.CTkFont(size=11))
        msg_lbl.pack(pady=4)

        def save():
            new_pwd = pwd_var.get()
            if not new_pwd:
                msg_lbl.configure(text="Password cannot be empty.", text_color="#ef4444")
                return
            ok, _ = self.db.update_user_password(user_id, new_pwd)
            if ok:
                dialog.destroy()
            else:
                msg_lbl.configure(text="Failed to update.", text_color="#ef4444")

        ctk.CTkButton(dialog, text="Save", fg_color="#4f46e5",
                      hover_color="#4338ca", command=save).pack(pady=10)

    def _delete_user(self, user_id, username):
        def do_delete():
            ok, result = self.db.delete_user(user_id)
            if ok:
                self._refresh_list()

        ConfirmDialog(self,
                      title="Delete User",
                      message=f"Delete user '{username}'? This cannot be undone.",
                      on_confirm=do_delete,
                      confirm_text="Delete",
                      confirm_color="#ef4444")


# ─────────────────────────── Job Row ────────────────────────────────────────
class JobRow(ctk.CTkFrame):
    """
    user_role: 'admin' | 'ops' | 'user'
      - admin : toggle + run enabled; full control
      - ops   : toggle + run enabled
      - user  : toggle disabled, run disabled (read-only)
    """
    def __init__(self, master, job_data, run_callback, toggle_callback,
                 history_callback, user_role="user"):
        super().__init__(master, fg_color="transparent", height=86)
        self.pack_propagate(False)
        self.grid_propagate(False)

        can_run = user_role in ("admin", "ops")
        can_toggle = user_role in ("admin", "ops")

        name_font = ctk.CTkFont(size=14, weight="bold")
        desc_font = ctk.CTkFont(size=11)

        # ── Name + description ──────────────────────────────────
        info_frame = ctk.CTkFrame(self, fg_color="transparent")
        info_frame.place(relx=0.0, rely=0.5, anchor="w", relwidth=0.33, x=8)

        name_color = ('#111827', 'white') if job_data["enabled"] else "#6b7280"
        ctk.CTkLabel(info_frame, text=job_data["name"], font=name_font,
                     text_color=name_color, anchor="w", justify="left").pack(anchor="w")

        desc = job_data.get("description") or "No description"
        if desc == "No description available.":
            desc = "No description"
        ctk.CTkLabel(info_frame, text=desc,
                     font=desc_font, text_color="gray", justify="left", wraplength=280).pack(anchor="w")

        # ── Status badge ────────────────────────────────────────
        status = job_data["last_run_status"]
        status_color = {
            "Succeeded": "#10b981",
            "Failed": "#ef4444",
            "In Progress": "#f59e0b",
            "Canceled": "#6b7280",
        }.get(status, "gray")

        badge_frame = ctk.CTkFrame(self, fg_color="transparent", border_width=1,
                                   border_color=status_color, corner_radius=6)
        badge_frame.place(relx=0.34, rely=0.5, anchor="w", x=8)
        ctk.CTkLabel(badge_frame, text=status, text_color=status_color,
                     font=ctk.CTkFont(size=11, weight="bold"),
                     padx=8, pady=2).pack()

        # ── Dates ───────────────────────────────────────────────
        last_run = job_data.get("start_execution_date")
        last_str = last_run.strftime("%Y-%m-%d %H:%M") if last_run else "Never"

        dur = job_data.get("duration_seconds")
        if dur is not None and last_run:
            dur_str = f"  ({dur}s)" if dur < 60 else f"  ({dur//60}m {dur%60}s)"
        else:
            dur_str = ""

        ctk.CTkLabel(self, text=last_str + dur_str,
                     font=ctk.CTkFont(size=12)).place(relx=0.48, rely=0.5, anchor="w", x=8)

        next_run = job_data.get("next_scheduled_run_date")
        next_str = next_run.strftime("%Y-%m-%d %H:%M") if next_run else "Not scheduled"
        ctk.CTkLabel(self, text=next_str, text_color="#9ca3af",
                     font=ctk.CTkFont(size=12)).place(relx=0.62, rely=0.5, anchor="w", x=8)

        # ── Action buttons ──────────────────────────────────────
        actions = ctk.CTkFrame(self, fg_color="transparent")
        actions.place(relx=0.76, rely=0.5, anchor="w", x=8)

        self.run_btn = ctk.CTkButton(
            actions, text="▶  Run", width=80,
            fg_color="transparent", border_width=1,
            border_color="#6366f1", text_color="#a5b4fc",
            hover_color="#312e81",
            state="normal" if (can_run and job_data["enabled"]) else "disabled",
            command=lambda: self._handle_run(job_data, run_callback)
        )
        self.run_btn.pack(side="left", padx=2)

        self.hist_btn = ctk.CTkButton(
            actions, text="📋", width=36,
            fg_color="transparent", border_width=1,
            border_color="#374151", text_color="#9ca3af",
            hover_color="#1f2937",
            command=lambda: history_callback(job_data["name"])
        )
        self.hist_btn.pack(side="left", padx=2)

        # ── Enable / Disable toggle ─────────────────────────────
        toggle_frame = ctk.CTkFrame(self, fg_color="transparent")
        toggle_frame.place(relx=0.92, rely=0.5, anchor="w", x=8)
        self.toggle_var = ctk.BooleanVar(value=bool(job_data["enabled"]))
        self.toggle_sw = ctk.CTkSwitch(
            toggle_frame, text="", variable=self.toggle_var,
            width=40, height=20,
            state="normal" if can_toggle else "disabled",
            command=lambda: toggle_callback(
                job_data["name"], self.toggle_var.get(), self.toggle_sw)
        )
        self.toggle_sw.pack()
        ctk.CTkLabel(toggle_frame, text="Enabled" if job_data["enabled"] else "Disabled",
                     font=ctk.CTkFont(size=10), text_color="gray").pack()

        # ── Separator ───────────────────────────────────────────
        sep = ctk.CTkFrame(self, height=1, fg_color=('#cbd5e1', '#222338'))
        sep.place(relx=0, rely=1.0, relwidth=1.0, anchor="sw")

    def _handle_run(self, job_data, run_callback):
        self.run_btn.configure(state="disabled", text="Running...")
        run_callback(job_data["name"], self.run_btn)
