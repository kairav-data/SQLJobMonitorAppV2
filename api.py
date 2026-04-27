"""
api.py - Python API exposed to the pywebview JavaScript front-end.
All public methods must return JSON-serialisable values.
"""

from datetime import datetime

import database
import sql_agent


def _dt(obj):
    return obj.isoformat() if isinstance(obj, datetime) else None


def _ser_job(job):
    return {
        "job_id": str(job["job_id"]) if job["job_id"] else None,
        "name": job["name"],
        "enabled": bool(job["enabled"]),
        "description": job.get("description") or "",
        "last_run_status": job["last_run_status"],
        "start_execution_date": _dt(job.get("start_execution_date")),
        "stop_execution_date": _dt(job.get("stop_execution_date")),
        "next_scheduled_run_date": _dt(job.get("next_scheduled_run_date")),
        "duration_seconds": job.get("duration_seconds"),
    }


def _ser_history(item):
    return {
        "status": item["status"],
        "run_datetime": _dt(item["run_datetime"]),
        "duration_seconds": item["duration_seconds"],
        "message": (item["message"] or "").strip(),
    }


class Api:
    def __init__(self):
        self._current_user_id = None
        self._current_role = None
        self._current_username = None

    # Auth

    def login(self, username, password):
        ok, role = database.authenticate(username, password)
        if not ok:
            self._clear_session()
            return {"ok": False, "role": None, "user_id": None}

        user = database.get_user_by_username(username)
        uid = user["id"] if user else None

        self._current_user_id = uid
        self._current_role = role
        self._current_username = user["username"] if user else username

        servers = database.get_servers_for_user(uid, role=role)
        default_server_id = servers[0]["id"] if servers else None

        default_project_id = None
        if default_server_id:
            projects = database.get_projects_for_user(uid, role=role, server_id=default_server_id)
            if len(projects) == 1:
                default_project_id = projects[0]["id"]

        return {
            "ok": True,
            "role": role,
            "user_id": uid,
            "username": self._current_username,
            "default_server_id": default_server_id,
            "default_project_id": default_project_id,
            "permissions": self._user_permissions(),
        }

    def logout(self):
        self._clear_session()
        return {"ok": True}

    # Servers

    def get_servers(self):
        if not self._is_authenticated():
            return []
        return database.get_servers_for_user(self._current_user_id, role=self._current_role)

    def add_server(self, alias, address, instance, user, password):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can add servers."}

        database.add_server(
            {
                "alias": alias,
                "address": address,
                "instance": instance,
                "user": user,
                "password": password,
            }
        )
        return {"ok": True, "servers": self.get_servers()}

    def delete_server(self, server_id):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can delete servers."}

        database.delete_server(server_id)
        return {"ok": True, "servers": self.get_servers()}

    def test_connection(self, alias, address, instance, user, password):
        if not self._is_admin():
            return {"ok": False, "message": "Only admins can test server connections."}

        ok, message = sql_agent.test_connection(
            {
                "alias": alias,
                "address": address,
                "instance": instance,
                "user": user,
                "password": password,
            }
        )
        return {"ok": ok, "message": message}

    # Jobs

    def fetch_jobs(self, server_id):
        server = self._authorized_server(server_id)
        if not server:
            return {"ok": False, "error": "Server not found or access denied."}
        if not self._user_permissions().get("view", False):
            return {"ok": True, "jobs": []}

        ok, result = sql_agent.fetch_jobs(server)
        if not ok:
            return {"ok": False, "error": str(result)}

        jobs = self._filter_jobs_for_user(result, server_id)
        return {"ok": True, "jobs": [_ser_job(job) for job in jobs]}

    def fetch_jobs_by_date(self, server_id, date_str):
        server = self._authorized_server(server_id)
        if not server:
            return {"ok": False, "error": "Server not found or access denied."}
        if not self._user_permissions().get("view", False):
            return {"ok": True, "jobs": []}

        ok, result = sql_agent.fetch_jobs_by_date(server, date_str)
        if not ok:
            return {"ok": False, "error": str(result)}

        jobs = self._filter_jobs_for_user(result, server_id)
        return {"ok": True, "jobs": [_ser_job(job) for job in jobs]}

    def run_job(self, server_id, job_name):
        server = self._authorized_server(server_id)
        if not server:
            return {"ok": False, "message": "Server not found or access denied."}
        if not self._can_run_job(server_id, job_name):
            return {"ok": False, "message": "You are not allowed to run this job."}

        ok, message = sql_agent.run_job(server, job_name)
        return {"ok": ok, "message": message}

    def set_job_enabled(self, server_id, job_name, enabled):
        server = self._authorized_server(server_id)
        if not server:
            return {"ok": False, "message": "Server not found or access denied."}
        if not self._can_toggle_jobs():
            return {"ok": False, "message": "Only admins and ops users can enable or disable jobs."}
        if not self._can_run_job(server_id, job_name):
            return {"ok": False, "message": "You are not allowed to modify this job."}

        ok, message = sql_agent.set_job_enabled(server, job_name, bool(enabled))
        return {"ok": ok, "message": message}

    def fetch_history(self, server_id, job_name):
        server = self._authorized_server(server_id)
        if not server:
            return {"ok": False, "error": "Server not found or access denied."}
        if not self._user_permissions().get("view", False):
            return {"ok": False, "error": "You do not have permission to view jobs."}
        if not self._can_view_job(server_id, job_name):
            return {"ok": False, "error": "You are not allowed to view this job."}

        ok, result = sql_agent.fetch_job_history(server, job_name)
        if not ok:
            return {"ok": False, "error": str(result)}
        return {"ok": True, "history": [_ser_history(item) for item in result]}

    def fetch_schedules(self, server_id):
        server = self._authorized_server(server_id)
        if not server:
            return {"ok": False, "error": "Server not found or access denied."}
        if not self._user_permissions().get("view", False):
            return {"ok": True, "schedules": {}}

        ok, result = sql_agent.fetch_job_schedules(server)
        if not ok:
            return {"ok": False, "error": str(result)}

        allowed_job_names = self._allowed_job_names(server_id)
        if allowed_job_names is not None:
            allowed = {str(n).strip().lower() for n in allowed_job_names if n}
            result = {
                job_name: dates
                for job_name, dates in result.items()
                if str(job_name).strip().lower() in allowed
            }

        serialized = {
            job_name: [_dt(dt) for dt in datetimes]
            for job_name, datetimes in result.items()
        }
        return {"ok": True, "schedules": serialized}

    def fetch_activity_dates(self, server_id, lookback_days=180):
        server = self._authorized_server(server_id)
        if not server:
            return {"ok": False, "error": "Server not found or access denied."}
        if not self._user_permissions().get("view", False):
            return {"ok": True, "activity": {}}

        ok, result = sql_agent.fetch_job_activity_dates(server, lookback_days=lookback_days)
        if not ok:
            return {"ok": False, "error": str(result)}

        allowed_job_names = self._allowed_job_names(server_id)
        if allowed_job_names is not None:
            allowed = {str(n).strip().lower() for n in allowed_job_names if n}
            filtered = {}
            for day, payload in result.items():
                jobs = [job_name for job_name in payload.get("jobs", []) if str(job_name).strip().lower() in allowed]
                if jobs:
                    filtered[day] = {"count": len(jobs), "jobs": jobs}
            result = filtered

        return {"ok": True, "activity": result}

    # Users

    def get_storage_status(self):
        return database.get_storage_status()

    def list_users(self):
        if not self._is_admin():
            return []
        return database.list_users()

    def add_user(self, username, password, role):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can add users."}

        ok, result = database.add_user(username, password, role)
        if ok:
            return {"ok": True, "users": result}
        return {"ok": False, "error": result}

    def update_password(self, user_id, new_password):
        if not (self._is_admin() or self._current_user_id == user_id):
            return {"ok": False, "error": "You are not allowed to change this password."}

        ok, result = database.update_user_password(user_id, new_password)
        if ok:
            return {"ok": True}
        return {"ok": False, "error": result}

    def update_user_permissions(self, user_id, permissions):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can change permissions."}
        ok, result = database.update_user_permissions(user_id, permissions)
        if ok:
            return {"ok": True, "users": result}
        return {"ok": False, "error": result}

    def delete_user(self, user_id):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can delete users."}

        ok, result = database.delete_user(user_id)
        if ok:
            return {"ok": True, "users": result}
        return {"ok": False, "error": result}

    # Projects

    def get_projects(self, server_id):
        if not self._can_access_server(server_id):
            return {"ok": False, "error": "Server not found or access denied.", "projects": []}
        if not self._user_permissions().get("view", False):
            return {"ok": True, "projects": []}

        projects = database.get_projects_for_user(
            self._current_user_id,
            role=self._current_role,
            server_id=server_id,
        )
        return {"ok": True, "projects": self._serialize_projects(projects)}

    def add_project(self, name, description, server_id):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can create projects."}
        if not database.get_server(server_id):
            return {"ok": False, "error": "Server not found."}

        projects = database.add_project(name, description, server_id)
        return {"ok": True, "projects": self._serialize_projects(projects)}

    def update_project_pipeline(self, project_id, jobs, nodes, edges):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can modify pipelines."}

        project = database.get_project_by_id(project_id)
        if not project:
            return {"ok": False, "error": "Project not found.", "projects": []}

        projects = database.update_project_pipeline(project_id, jobs, nodes, edges)
        return {"ok": True, "projects": self._serialize_projects(projects)}

    def update_project_assignments(self, project_id, user_ids):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can change project access."}

        project = database.get_project_by_id(project_id)
        if not project:
            return {"ok": False, "error": "Project not found.", "projects": []}

        projects = database.update_project_assignments(project_id, user_ids)
        return {"ok": True, "projects": self._serialize_projects(projects)}

    def delete_project(self, project_id):
        if not self._is_admin():
            return {"ok": False, "error": "Only admins can delete projects."}

        projects = database.delete_project(project_id)
        return {"ok": True, "projects": self._serialize_projects(projects)}

    # SQL Download

    def execute_sql_download(self, server_id, sql_query):
        """
        Execute a SELECT-only SQL query against the chosen server and return
        all data as JSON with every cell value converted to a plain string.
        """
        server = self._authorized_server(server_id)
        if not server:
            return {"ok": False, "error": "Server not found or access denied."}

        ok, result = sql_agent.execute_select_query(server, sql_query)
        if not ok:
            return {"ok": False, "error": str(result)}

        return {
            "ok": True,
            "columns": result["columns"],
            "rows": result["rows"],
            "row_count": len(result["rows"]),
        }

    def save_csv_file(self, filename_hint, csv_content):
        """
        Open a native OS 'Save As' dialog so the user can choose where to save
        the CSV file, then write the content to the chosen path.
        Returns {"ok": True, "path": "..."} on success,
                {"ok": False, "cancelled": True} if the user cancelled,
                {"ok": False, "error": "..."} on write failure.
        """
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()          # hide the root window
            root.attributes('-topmost', True)  # dialog appears on top of pywebview

            filepath = filedialog.asksaveasfilename(
                parent=root,
                title="Save Query Results",
                initialfile=filename_hint,
                defaultextension=".csv",
                filetypes=[
                    ("CSV (comma-separated)", "*.csv"),
                    ("Excel Workbook", "*.xlsx"),
                    ("All files", "*.*"),
                ],
            )
            root.destroy()

            if not filepath:
                return {"ok": False, "cancelled": True}

            # Write UTF-8 BOM CSV so Excel opens it correctly as all-text
            with open(filepath, "w", encoding="utf-8-sig", newline="") as f:
                f.write(csv_content)

            return {"ok": True, "path": filepath}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # Internal helpers

    def _clear_session(self):
        self._current_user_id = None
        self._current_role = None
        self._current_username = None

    def _is_authenticated(self):
        return bool(self._current_user_id)

    def _role(self):
        return str(self._current_role or "").strip().lower()

    def _is_admin(self):
        return self._role() == "admin"

    def _user_permissions(self):
        if self._is_admin():
            return {"view": True, "run": True, "toggle": True}
        user = database.get_user_by_id(self._current_user_id)
        if not user:
            return {"view": False, "run": False, "toggle": False}
        return user.get("permissions", {})

    def _can_toggle_jobs(self):
        return self._user_permissions().get("toggle", False)

    def _has_global_job_access(self):
        return self._role() == "admin"

    def _can_access_server(self, server_id):
        if not self._is_authenticated():
            return False
        return database.user_can_access_server(
            self._current_user_id,
            server_id,
            role=self._current_role,
        )

    def _authorized_server(self, server_id):
        if not self._can_access_server(server_id):
            return None
        return database.get_server(server_id)

    def _allowed_job_names(self, server_id):
        return database.get_allowed_job_names_for_user(
            self._current_user_id,
            role=self._current_role,
            server_id=server_id,
        )

    def _filter_jobs_for_user(self, jobs, server_id):
        allowed_job_names = self._allowed_job_names(server_id)
        if allowed_job_names is None:
            return jobs
        allowed = {str(n).strip().lower() for n in allowed_job_names if n}
        return [job for job in jobs if str(job.get("name") or "").strip().lower() in allowed]

    def _can_view_job(self, server_id, job_name):
        if self._has_global_job_access():
            return self._can_access_server(server_id)
        return database.user_can_run_job(
            self._current_user_id,
            server_id,
            job_name,
            role=self._current_role,
        )

    def _can_run_job(self, server_id, job_name):
        if not self._is_authenticated():
            return False
        if not self._user_permissions().get("run", False):
            return False
        if self._has_global_job_access():
            return self._can_access_server(server_id)
        return database.user_can_run_job(
            self._current_user_id,
            server_id,
            job_name,
            role=self._current_role,
        )

    def _serialize_projects(self, projects):
        include_assignments = self._is_admin()
        users_by_id = {}
        if include_assignments:
            users_by_id = {
                user["id"]: user["username"]
                for user in database.list_users()
            }

        result = []
        for project in projects or []:
            item = {
                "id": project.get("id"),
                "name": project.get("name") or "",
                "description": project.get("description") or "",
                "server_id": project.get("server_id"),
                "jobs": list(project.get("jobs") or []),
                "nodes": dict(project.get("nodes") or {}),
                "edges": list(project.get("edges") or []),
            }

            if include_assignments:
                assigned_user_ids = list(project.get("assigned_user_ids") or [])
                item["assigned_user_ids"] = assigned_user_ids
                item["assigned_users"] = [
                    {"id": user_id, "username": users_by_id.get(user_id, user_id)}
                    for user_id in assigned_user_ids
                ]
                item["assigned_count"] = len(item["assigned_users"])

            result.append(item)

        return result
