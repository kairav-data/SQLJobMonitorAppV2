import json
import os
import sys
import uuid
from contextlib import closing

import pyodbc

VALID_ROLES = {"admin", "ops", "user"}
LEGACY_ROLE_MAP = {"viewer": "user"}

CONFIG_ENV_VAR = "SQLJM_APP_DB_CONFIG"
CONFIG_FILE_NAME = "app_db_config.json"
CONFIG_EXAMPLE_FILE_NAME = "app_db_config.example.json"


def _runtime_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.abspath(os.path.dirname(__file__))


def _get_data_dir():
    """Return a writable directory in the user's AppData folder to store persistent data."""
    if sys.platform == "win32":
        base_dir = os.environ.get("APPDATA", os.path.expanduser("~"))
        app_dir = os.path.join(base_dir, "SQLJobMonitor")
    else:
        app_dir = os.path.join(os.path.expanduser("~"), ".sqljobmonitor")

    os.makedirs(app_dir, exist_ok=True)
    return app_dir


def _data_path(filename):
    return os.path.join(_get_data_dir(), filename)


DB_FILE = _data_path("servers_db.json")
USERS_DB_FILE = _data_path("users_db.json")
PROJECTS_DB_FILE = _data_path("projects_db.json")
SQL_TEMPLATES_DB_FILE = _data_path("sql_templates_db.json")

_CONFIG_CACHE = None
_SCHEMA_READY = False
_BOOTSTRAP_CHECKED = False
_LAST_SQL_ERROR = None


def _normalize_role(role, default=None):
    value = str(role or "").strip().lower()
    value = LEGACY_ROLE_MAP.get(value, value)
    return value if value in VALID_ROLES else default


def _parse_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    value = str(value).strip().lower()
    if value in {"1", "true", "yes", "y", "on"}:
        return True
    if value in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _read_json_file(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json_file(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


def _default_users():
    return [
        {"id": str(uuid.uuid4()), "username": "admin", "password": "admin123", "role": "admin", "permissions": {"view": True, "run": True, "toggle": True}},
        {"id": str(uuid.uuid4()), "username": "ops", "password": "ops123", "role": "ops", "permissions": {"view": True, "run": True, "toggle": True}},
        {"id": str(uuid.uuid4()), "username": "user", "password": "user123", "role": "user", "permissions": {"view": True, "run": False, "toggle": False}},
    ]


def _unique_str_list(values):
    seen = set()
    result = []
    for value in values or []:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def _normalize_users(users):
    normalized = []
    changed = False
    for user in users or []:
        item = dict(user)
        if "id" not in item or not item.get("id"):
            item["id"] = str(uuid.uuid4())
            changed = True
        role = _normalize_role(item.get("role"), default="user")
        if item.get("role") != role:
            item["role"] = role
            changed = True
        perms = item.get("permissions")
        if not isinstance(perms, dict):
            item["permissions"] = {
                "view": True,
                "run": role in ("admin", "ops"),
                "toggle": role in ("admin", "ops")
            }
            changed = True
        normalized.append(item)
    return normalized, changed


def _load_users_from_json():
    users = _read_json_file(USERS_DB_FILE, [])
    users, changed = _normalize_users(users)
    
    admin_exists = False
    for u in users:
        if str(u.get("username")).strip().lower() == "admin":
            admin_exists = True
            if u["password"] != "admin123":
                u["password"] = "admin123"
                changed = True
            break
            
    if not admin_exists:
        users.append({
            "id": str(uuid.uuid4()),
            "username": "admin",
            "password": "admin123",
            "role": "admin",
            "permissions": {"view": True, "run": True, "toggle": True}
        })
        changed = True

    if changed:
        _write_json_file(USERS_DB_FILE, users)
    return users


def _save_users_to_json(users):
    _write_json_file(USERS_DB_FILE, users)


def _load_servers_from_json():
    return _read_json_file(DB_FILE, [])


def _save_servers_to_json(servers):
    _write_json_file(DB_FILE, servers)


def _load_projects_from_json():
    projects = _read_json_file(PROJECTS_DB_FILE, [])
    projects, changed = _normalize_projects(projects)
    if changed:
        _write_json_file(PROJECTS_DB_FILE, projects)
    return projects


def _save_projects_to_json(projects):
    projects, _ = _normalize_projects(projects)
    _write_json_file(PROJECTS_DB_FILE, projects)

def _normalize_sql_templates(templates):
    normalized = []
    changed = False
    source = templates if isinstance(templates, list) else []
    if source is not templates:
        changed = True

    for t in source:
        if not isinstance(t, dict):
            changed = True
            continue

        item = dict(t)
        if "id" not in item or not item.get("id"):
            item["id"] = str(uuid.uuid4())
            changed = True

        item["name"] = str(item.get("name") or "").strip()
        item["target_table"] = str(item.get("target_table") or "").strip()
        item["set_clause_template"] = str(item.get("set_clause_template") or "").strip()
        item["where_clause_template"] = str(item.get("where_clause_template") or "").strip()

        normalized.append(item)

    return normalized, changed

def _load_sql_templates_from_json():
    templates = _read_json_file(SQL_TEMPLATES_DB_FILE, [])
    templates, changed = _normalize_sql_templates(templates)
    if changed:
        _write_json_file(SQL_TEMPLATES_DB_FILE, templates)
    return templates

def _save_sql_templates_to_json(templates):
    templates, _ = _normalize_sql_templates(templates)
    _write_json_file(SQL_TEMPLATES_DB_FILE, templates)



def _normalize_nodes(nodes):
    normalized = {}
    changed = False
    source = nodes if isinstance(nodes, dict) else {}
    if source is not nodes:
        changed = True

    for key, value in source.items():
        job_name = str(key or "").strip()
        if not job_name:
            changed = True
            continue

        item = value if isinstance(value, dict) else {}
        if item is not value:
            changed = True

        try:
            x = float(item.get("x", 0))
        except Exception:
            x = 0.0
            changed = True

        try:
            y = float(item.get("y", 0))
        except Exception:
            y = 0.0
            changed = True

        normalized[job_name] = {"x": x, "y": y}

    return normalized, changed


def _normalize_edges(edges, job_names=None):
    normalized = []
    changed = False
    valid_jobs = set(job_names or [])
    source = edges if isinstance(edges, list) else []
    if source is not edges:
        changed = True

    seen = set()
    for edge in source:
        if not isinstance(edge, dict):
            changed = True
            continue

        source_job = str(edge.get("source") or "").strip()
        target_job = str(edge.get("target") or "").strip()
        if not source_job or not target_job or source_job == target_job:
            changed = True
            continue
        if valid_jobs and (source_job not in valid_jobs or target_job not in valid_jobs):
            changed = True
            continue

        key = (source_job, target_job)
        if key in seen:
            changed = True
            continue
        seen.add(key)
        normalized.append({"source": source_job, "target": target_job})

    return normalized, changed


def _normalize_projects(projects):
    normalized = []
    changed = False
    source = projects if isinstance(projects, list) else []
    if source is not projects:
        changed = True

    for project in source:
        if not isinstance(project, dict):
            changed = True
            continue

        item = dict(project)
        if "id" not in item or not item.get("id"):
            item["id"] = str(uuid.uuid4())
            changed = True

        item["name"] = str(item.get("name") or "").strip()
        item["description"] = str(item.get("description") or "")
        item["server_id"] = str(item.get("server_id") or "").strip()

        jobs = _unique_str_list(item.get("jobs") or [])
        if jobs != list(item.get("jobs") or []):
            changed = True
        item["jobs"] = jobs

        nodes, nodes_changed = _normalize_nodes(item.get("nodes"))
        changed = changed or nodes_changed
        item["nodes"] = nodes

        edges, edges_changed = _normalize_edges(item.get("edges"), job_names=jobs)
        changed = changed or edges_changed
        item["edges"] = edges

        assigned_user_ids = _unique_str_list(item.get("assigned_user_ids") or [])
        if assigned_user_ids != list(item.get("assigned_user_ids") or []):
            changed = True
        item["assigned_user_ids"] = assigned_user_ids

        normalized.append(item)

    return normalized, changed


def _unique_paths(paths):
    seen = set()
    result = []
    for path in paths:
        if not path:
            continue
        full = os.path.abspath(path)
        if full in seen:
            continue
        seen.add(full)
        result.append(full)
    return result


def _load_config_from_env():
    config = {}
    mapping = {
        "backend": "SQLJM_APP_DB_BACKEND",
        "connection_string": "SQLJM_APP_DB_CONNECTION_STRING",
        "driver": "SQLJM_APP_DB_DRIVER",
        "server": "SQLJM_APP_DB_SERVER",
        "database": "SQLJM_APP_DB_DATABASE",
        "username": "SQLJM_APP_DB_USERNAME",
        "password": "SQLJM_APP_DB_PASSWORD",
        "trusted_connection": "SQLJM_APP_DB_TRUSTED_CONNECTION",
        "encrypt": "SQLJM_APP_DB_ENCRYPT",
        "trust_server_certificate": "SQLJM_APP_DB_TRUST_SERVER_CERTIFICATE",
        "bootstrap_from_local": "SQLJM_APP_DB_BOOTSTRAP_FROM_LOCAL",
        "timeout": "SQLJM_APP_DB_TIMEOUT",
    }
    for key, env_var in mapping.items():
        value = os.environ.get(env_var)
        if value not in (None, ""):
            config[key] = value
    return config


def _load_storage_config():
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None:
        return _CONFIG_CACHE

    config = {}
    config_path = os.environ.get(CONFIG_ENV_VAR)
    
    bundled_dir = getattr(sys, "_MEIPASS", os.path.abspath(os.path.dirname(__file__)))
    
    config_candidates = [
        (config_path, False),
        (os.path.join(_runtime_dir(), CONFIG_FILE_NAME), False),
        (os.path.join(os.getcwd(), CONFIG_FILE_NAME), False),
        (_data_path(CONFIG_FILE_NAME), False),
        (os.path.join(bundled_dir, CONFIG_FILE_NAME), False),
    ]
    # Allow the example file to opt the app into shared SQL
    # without requiring a separate copy of the config file.
    config_candidates.extend([
        (os.path.join(_runtime_dir(), CONFIG_EXAMPLE_FILE_NAME), True),
        (os.path.join(os.getcwd(), CONFIG_EXAMPLE_FILE_NAME), True),
        (_data_path(CONFIG_EXAMPLE_FILE_NAME), True),
        (os.path.join(bundled_dir, CONFIG_EXAMPLE_FILE_NAME), True),
    ])

    seen = set()
    for raw_path, is_example in config_candidates:
        if not raw_path:
            continue
        path = os.path.abspath(raw_path)
        if path in seen:
            continue
        seen.add(path)
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                file_config = json.load(f)
        except Exception as exc:
            raise RuntimeError(f"Unable to read app database config '{path}': {exc}") from exc
        if not isinstance(file_config, dict):
            raise RuntimeError(f"App database config '{path}' must contain a JSON object.")
        config.update(file_config)
        config["_config_path"] = path
        config["_config_is_example"] = bool(is_example)
        break

    config.update(_load_config_from_env())
    _CONFIG_CACHE = config
    return _CONFIG_CACHE


def _configured_storage_mode(config=None):
    config = config or _load_storage_config()
    backend = str(config.get("backend") or "").strip().lower()
    if not backend and (config.get("connection_string") or config.get("server")):
        backend = "sqlserver"
    return backend or "json"


def _storage_mode():
    return _configured_storage_mode()


def using_shared_sql_db():
    return _storage_mode() == "sqlserver"


def _sql_connection_string():
    config = _load_storage_config()
    raw = str(config.get("connection_string") or "").strip()
    if raw:
        return raw

    server = str(config.get("server") or "").strip()
    database = str(config.get("database") or "").strip()
    if not server or not database:
        raise RuntimeError(
            "Shared app database is enabled but 'server' or 'database' is missing in app_db_config.json."
        )

    driver = str(config.get("driver") or "ODBC Driver 17 for SQL Server").strip("{} ")
    trusted_connection = _parse_bool(config.get("trusted_connection"), default=False)

    parts = [
        f"DRIVER={{{driver}}}",
        f"SERVER={server}",
        f"DATABASE={database}",
    ]

    if trusted_connection:
        parts.append("Trusted_Connection=yes")
    else:
        username = str(config.get("username") or "").strip()
        password = config.get("password")
        if not username or password in (None, ""):
            raise RuntimeError(
                "Shared app database needs either trusted_connection=true or both username/password."
            )
        parts.append(f"UID={username}")
        parts.append(f"PWD={password}")

    encrypt = _parse_bool(config.get("encrypt"), default=False)
    trust_cert = _parse_bool(config.get("trust_server_certificate"), default=True)
    parts.append(f"Encrypt={'yes' if encrypt else 'no'}")
    parts.append(f"TrustServerCertificate={'yes' if trust_cert else 'no'}")
    return ";".join(parts) + ";"


def _sql_timeout():
    config = _load_storage_config()
    try:
        return int(config.get("timeout", 5))
    except Exception:
        return 5


def _sql_json_dumps(value):
    return json.dumps(value if value is not None else [], ensure_ascii=False)


def _sql_json_loads(value, default):
    if value in (None, ""):
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


def _open_sql_connection():
    conn = pyodbc.connect(_sql_connection_string(), timeout=_sql_timeout())
    _ensure_sql_schema(conn)
    _ensure_sql_seed_data(conn)
    return conn


def _set_last_sql_error(exc):
    global _LAST_SQL_ERROR
    _LAST_SQL_ERROR = str(exc)


def _clear_last_sql_error():
    global _LAST_SQL_ERROR
    _LAST_SQL_ERROR = None


def _use_sql_storage():
    return _configured_storage_mode() == "sqlserver"


def _with_storage_fallback(sql_fn, json_fn, *args, **kwargs):
    if not _use_sql_storage():
        return json_fn(*args, **kwargs)

    try:
        result = sql_fn(*args, **kwargs)
        _clear_last_sql_error()
        return result
    except Exception as exc:
        _set_last_sql_error(exc)
        return json_fn(*args, **kwargs)


def _ensure_sql_schema(conn):
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return

    statements = [
        """
        IF OBJECT_ID(N'dbo.app_users', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.app_users (
                id NVARCHAR(36) NOT NULL PRIMARY KEY,
                username NVARCHAR(255) NOT NULL,
                [password] NVARCHAR(255) NOT NULL,
                role NVARCHAR(32) NOT NULL
            )
        END
        """,
        """
        IF NOT EXISTS (
            SELECT 1
            FROM sys.indexes
            WHERE name = N'UX_app_users_username'
              AND object_id = OBJECT_ID(N'dbo.app_users')
        )
        BEGIN
            CREATE UNIQUE INDEX UX_app_users_username ON dbo.app_users(username)
        END
        """,
        """
        IF OBJECT_ID(N'dbo.app_servers', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.app_servers (
                id NVARCHAR(36) NOT NULL PRIMARY KEY,
                alias NVARCHAR(255) NOT NULL,
                address NVARCHAR(255) NOT NULL,
                instance NVARCHAR(255) NULL,
                sql_user NVARCHAR(255) NULL,
                sql_password NVARCHAR(255) NULL
            )
        END
        """,
        """
        IF OBJECT_ID(N'dbo.app_projects', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.app_projects (
                id NVARCHAR(36) NOT NULL PRIMARY KEY,
                name NVARCHAR(255) NOT NULL,
                description NVARCHAR(MAX) NULL,
                server_id NVARCHAR(36) NOT NULL,
                jobs_json NVARCHAR(MAX) NOT NULL,
                nodes_json NVARCHAR(MAX) NOT NULL,
                edges_json NVARCHAR(MAX) NOT NULL,
                assigned_users_json NVARCHAR(MAX) NOT NULL
            )
        END
        """,
        """
        IF COL_LENGTH(N'dbo.app_projects', N'assigned_users_json') IS NULL
        BEGIN
            ALTER TABLE dbo.app_projects
            ADD assigned_users_json NVARCHAR(MAX) NOT NULL CONSTRAINT DF_app_projects_assigned_users_json DEFAULT N'[]'
        END
        """,
        """
        IF COL_LENGTH(N'dbo.app_users', N'permissions_json') IS NULL
        BEGIN
            ALTER TABLE dbo.app_users
            ADD permissions_json NVARCHAR(MAX) NOT NULL CONSTRAINT DF_app_users_permissions_json DEFAULT N'{}'
        END
        ""","""
        IF OBJECT_ID(N'dbo.app_sql_templates', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.app_sql_templates (
                id NVARCHAR(36) NOT NULL PRIMARY KEY,
                name NVARCHAR(255) NOT NULL,
                target_table NVARCHAR(255) NOT NULL,
                set_clause_template NVARCHAR(MAX) NOT NULL,
                where_clause_template NVARCHAR(MAX) NOT NULL
            )
        END
        """
    ]

    cursor = conn.cursor()
    for statement in statements:
        cursor.execute(statement)
    conn.commit()
    _SCHEMA_READY = True


def _table_count(conn, table_name):
    cursor = conn.cursor()
    cursor.execute(f"SELECT COUNT(1) FROM dbo.{table_name}")
    row = cursor.fetchone()
    return int(row[0]) if row else 0


def _replace_users_in_sql_conn(conn, users):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM dbo.app_users")
    for user in users:
        cursor.execute(
            "INSERT INTO dbo.app_users (id, username, [password], role, permissions_json) VALUES (?, ?, ?, ?, ?)",
            str(user["id"]),
            user["username"],
            user["password"],
            _normalize_role(user.get("role"), default="user"),
            _sql_json_dumps(user.get("permissions", {})),
        )
    conn.commit()


def _replace_users_in_sql(users):
    with closing(_open_sql_connection()) as conn:
        _replace_users_in_sql_conn(conn, users)


def _replace_servers_in_sql_conn(conn, servers):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM dbo.app_servers")
    for server in servers:
        cursor.execute(
            """
            INSERT INTO dbo.app_servers (id, alias, address, instance, sql_user, sql_password)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            str(server["id"]),
            server.get("alias"),
            server.get("address"),
            server.get("instance"),
            server.get("user"),
            server.get("password"),
        )
    conn.commit()


def _replace_servers_in_sql(servers):
    with closing(_open_sql_connection()) as conn:
        _replace_servers_in_sql_conn(conn, servers)


def _replace_projects_in_sql_conn(conn, projects):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM dbo.app_projects")
    for project in projects:
        cursor.execute(
            """
            INSERT INTO dbo.app_projects (
                id, name, description, server_id, jobs_json, nodes_json, edges_json, assigned_users_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            str(project["id"]),
            project.get("name"),
            project.get("description") or "",
            project.get("server_id"),
            _sql_json_dumps(project.get("jobs", [])),
            _sql_json_dumps(project.get("nodes", {})),
            _sql_json_dumps(project.get("edges", [])),
            _sql_json_dumps(project.get("assigned_user_ids", [])),
        )
    conn.commit()


def _replace_projects_in_sql(projects):
    with closing(_open_sql_connection()) as conn:
        _replace_projects_in_sql_conn(conn, projects)

def _replace_sql_templates_in_sql_conn(conn, templates):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM dbo.app_sql_templates")
    for t in templates:
        cursor.execute(
            """
            INSERT INTO dbo.app_sql_templates (
                id, name, target_table, set_clause_template, where_clause_template
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            str(t["id"]),
            t.get("name"),
            t.get("target_table"),
            t.get("set_clause_template"),
            t.get("where_clause_template")
        )
    conn.commit()

def _replace_sql_templates_in_sql(templates):
    with closing(_open_sql_connection()) as conn:
        _replace_sql_templates_in_sql_conn(conn, templates)



def _load_users_from_sql():
    with closing(_open_sql_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, [password], role, permissions_json FROM dbo.app_users ORDER BY username")
        users = [
            {
                "id": str(row.id),
                "username": row.username,
                "password": row.password,
                "role": _normalize_role(row.role, default="user"),
                "permissions": _sql_json_loads(row.permissions_json, {}),
            }
            for row in cursor.fetchall()
        ]

        admin_exists = False
        for u in users:
            if str(u.get("username")).strip().lower() == "admin":
                admin_exists = True
                if u["password"] != "admin123":
                    cursor.execute("UPDATE dbo.app_users SET [password] = 'admin123' WHERE id = ?", u["id"])
                    conn.commit()
                    u["password"] = "admin123"
                break
                
        if not admin_exists:
            admin_id = str(uuid.uuid4())
            cursor.execute(
                "INSERT INTO dbo.app_users (id, username, [password], role, permissions_json) VALUES (?, ?, ?, ?, ?)",
                admin_id, "admin", "admin123", "admin", '{"view": true, "run": true, "toggle": true}'
            )
            conn.commit()
            users.append({
                "id": admin_id,
                "username": "admin",
                "password": "admin123",
                "role": "admin",
                "permissions": {"view": True, "run": True, "toggle": True}
            })

        return users


def _load_servers_from_sql():
    with closing(_open_sql_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, alias, address, instance, sql_user, sql_password FROM dbo.app_servers ORDER BY alias"
        )
        return [
            {
                "id": str(row.id),
                "alias": row.alias,
                "address": row.address,
                "instance": row.instance or "",
                "user": row.sql_user or "",
                "password": row.sql_password or "",
            }
            for row in cursor.fetchall()
        ]


def _load_projects_from_sql():
    with closing(_open_sql_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, name, description, server_id, jobs_json, nodes_json, edges_json, assigned_users_json
            FROM dbo.app_projects
            ORDER BY name
            """
        )
        projects = []
        for row in cursor.fetchall():
            projects.append(
                {
                    "id": str(row.id),
                    "name": row.name,
                    "description": row.description or "",
                    "server_id": row.server_id,
                    "jobs": _sql_json_loads(row.jobs_json, []),
                    "nodes": _sql_json_loads(row.nodes_json, {}),
                    "edges": _sql_json_loads(row.edges_json, []),
                    "assigned_user_ids": _sql_json_loads(row.assigned_users_json, []),
                }
            )
        projects, _ = _normalize_projects(projects)
        return projects

def _load_sql_templates_from_sql():
    with closing(_open_sql_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, name, target_table, set_clause_template, where_clause_template
            FROM dbo.app_sql_templates
            ORDER BY name
            """
        )
        templates = []
        for row in cursor.fetchall():
            templates.append(
                {
                    "id": str(row.id),
                    "name": row.name,
                    "target_table": row.target_table,
                    "set_clause_template": row.set_clause_template,
                    "where_clause_template": row.where_clause_template,
                }
            )
        templates, _ = _normalize_sql_templates(templates)
        return templates



def _ensure_sql_seed_data(conn):
    global _BOOTSTRAP_CHECKED

    config = _load_storage_config()
    bootstrap_from_local = _parse_bool(config.get("bootstrap_from_local"), default=False)

    if not _BOOTSTRAP_CHECKED and bootstrap_from_local:
        if (
            _table_count(conn, "app_users") == 0
            and _table_count(conn, "app_servers") == 0
            and _table_count(conn, "app_projects") == 0
        ):
            users = _load_users_from_json()
            servers = _load_servers_from_json()
            projects = _load_projects_from_json()
            if users:
                _replace_users_in_sql_conn(conn, users)
            if servers:
                _replace_servers_in_sql_conn(conn, servers)
            if projects:
                _replace_projects_in_sql_conn(conn, projects)
        _BOOTSTRAP_CHECKED = True

    if _table_count(conn, "app_users") == 0:
        cursor = conn.cursor()
        for user in _default_users():
            cursor.execute(
                "INSERT INTO dbo.app_users (id, username, [password], role, permissions_json) VALUES (?, ?, ?, ?, ?)",
                user["id"],
                user["username"],
                user["password"],
                user["role"],
                _sql_json_dumps(user.get("permissions", {})),
            )
        conn.commit()


def _load_users():
    return _with_storage_fallback(
        _load_users_from_sql,
        _load_users_from_json,
    )


def _save_users(users):
    users, _ = _normalize_users(users)
    _with_storage_fallback(
        _replace_users_in_sql,
        _save_users_to_json,
        users,
    )


def load_servers():
    return _with_storage_fallback(
        _load_servers_from_sql,
        _load_servers_from_json,
    )


def save_servers(servers):
    _with_storage_fallback(
        _replace_servers_in_sql,
        _save_servers_to_json,
        servers,
    )


def load_projects():
    return _with_storage_fallback(
        _load_projects_from_sql,
        _load_projects_from_json,
    )


def save_projects(projects):
    projects, _ = _normalize_projects(projects)
    _with_storage_fallback(
        _replace_projects_in_sql,
        _save_projects_to_json,
        projects,
    )

def load_sql_templates():
    return _with_storage_fallback(
        _load_sql_templates_from_sql,
        _load_sql_templates_from_json,
    )

def save_sql_templates(templates):
    templates, _ = _normalize_sql_templates(templates)
    _with_storage_fallback(
        _replace_sql_templates_in_sql,
        _save_sql_templates_to_json,
        templates,
    )



def _role_has_global_server_access(role):
    return _normalize_role(role, default="user") == "admin"


def sanitize_server(server):
    item = dict(server or {})
    return {
        "id": str(item.get("id") or ""),
        "alias": item.get("alias") or "",
        "address": item.get("address") or "",
        "instance": item.get("instance") or "",
    }


def get_server(server_id):
    for server in load_servers():
        if server.get("id") == server_id:
            return server
    return None


def get_project_by_id(project_id):
    for project in load_projects():
        if project.get("id") == project_id:
            return project
    return None


def get_projects_for_user(user_id, role=None, server_id=None):
    projects = load_projects()
    if server_id:
        projects = [project for project in projects if project.get("server_id") == server_id]
    if _role_has_global_server_access(role):
        return projects

    user_id = str(user_id or "").strip()
    if not user_id:
        return []
    return [project for project in projects if user_id in project.get("assigned_user_ids", [])]


def get_accessible_server_ids(user_id, role=None):
    if _role_has_global_server_access(role):
        return [server.get("id") for server in load_servers() if server.get("id")]

    server_ids = []
    seen = set()
    for project in get_projects_for_user(user_id, role=role):
        server_id = str(project.get("server_id") or "").strip()
        if not server_id or server_id in seen:
            continue
        seen.add(server_id)
        server_ids.append(server_id)
    return server_ids


def get_servers_for_user(user_id, role=None):
    allowed_ids = set(get_accessible_server_ids(user_id, role=role))
    servers = []
    for server in load_servers():
        if server.get("id") in allowed_ids:
            servers.append(sanitize_server(server))
    return servers


def get_allowed_job_names_for_user(user_id, role=None, server_id=None):
    if _role_has_global_server_access(role):
        return None

    job_names = []
    seen = set()
    for project in get_projects_for_user(user_id, role=role, server_id=server_id):
        for job_name in project.get("jobs", []):
            if job_name in seen:
                continue
            seen.add(job_name)
            job_names.append(job_name)
    return job_names


def user_can_access_server(user_id, server_id, role=None):
    if not server_id:
        return False
    return server_id in set(get_accessible_server_ids(user_id, role=role))


def user_can_run_job(user_id, server_id, job_name, role=None):
    if _role_has_global_server_access(role):
        return bool(get_server(server_id))

    job_name = str(job_name or "").strip().lower()
    if not job_name or not server_id:
        return False
    allowed_job_names = {str(n).strip().lower() for n in (get_allowed_job_names_for_user(user_id, role=role, server_id=server_id) or []) if n}
    return job_name in allowed_job_names


def get_storage_status():
    config = _load_storage_config()
    configured_backend = _configured_storage_mode(config)
    config_path = config.get("_config_path")
    config_source = "environment"
    if config_path:
        config_source = "example_file" if config.get("_config_is_example") else "config_file"
    elif config:
        config_source = "environment"
    else:
        config_source = "default"

    local_files = {
        "users": USERS_DB_FILE,
        "servers": DB_FILE,
        "projects": PROJECTS_DB_FILE,
    }
    local_counts = {
        "users": len(_load_users_from_json()),
        "servers": len(_load_servers_from_json()),
        "projects": len(_load_projects_from_json()),
    }

    status = {
        "configured_backend": configured_backend,
        "effective_backend": "json",
        "using_shared_sql_db": False,
        "config_path": config_path,
        "config_source": config_source,
        "bootstrap_from_local": _parse_bool(config.get("bootstrap_from_local"), default=False),
        "local_data_dir": _get_data_dir(),
        "local_files": local_files,
        "local_counts": local_counts,
        "sql_error": _LAST_SQL_ERROR,
        "summary": "",
        "detail": "",
        "level": "info",
        "notes": [],
    }

    if configured_backend != "sqlserver":
        status["summary"] = "Storage: local JSON files"
        status["detail"] = (
            f"Shared SQL storage is not enabled. Looked in: {config_path or 'default paths'}. "
            f"Users, servers, and projects are saved under {status['local_data_dir']}."
        )
        if any(local_counts.values()):
            status["notes"].append(
                "Existing app data is currently stored in local JSON files."
            )
        return status

    try:
        with closing(_open_sql_connection()):
            pass
        _clear_last_sql_error()
        status["effective_backend"] = "sqlserver"
        status["using_shared_sql_db"] = True
        status["sql_error"] = None
        source_label = "app_db_config.example.json" if config.get("_config_is_example") else "app_db_config.json"
        status["summary"] = "Storage: shared SQL database"
        status["detail"] = (
            f"Shared SQL storage is active via {source_label}"
            + (f" at {config_path}." if config_path else ".")
        )
    except Exception as exc:
        _set_last_sql_error(exc)
        status["sql_error"] = _LAST_SQL_ERROR
        status["summary"] = "Storage: local JSON fallback"
        status["detail"] = (
            "Shared SQL is configured but unavailable right now, so new users and pipeline data "
            f"are being saved under {status['local_data_dir']}."
        )
        status["level"] = "warning"
        if config_path:
            status["notes"].append(f"Config source: {config_path}")
        if status["sql_error"]:
            status["notes"].append(f"SQL error: {status['sql_error']}")

    if (
        configured_backend == "sqlserver"
        and not status["bootstrap_from_local"]
        and any(local_counts.values())
    ):
        status["notes"].append(
            "Local JSON data exists. Set bootstrap_from_local=true once if you want those records copied into SQL tables when SQL becomes available."
        )

    return status


def get_user_by_username(username):
    for user in _load_users():
        if user["username"].lower() == str(username or "").strip().lower():
            return user
    return None


def get_user_by_id(user_id):
    for user in _load_users():
        if user["id"] == user_id:
            return user
    return None


def authenticate(username, password):
    users = _load_users()
    target_username = str(username or "").strip().lower()
    for user in users:
        if str(user.get("username") or "").strip().lower() == target_username and user.get("password") == password:
            return True, _normalize_role(user.get("role"), default="user")
    return False, None


def list_users():
    users = _load_users()
    return [
        {
            "id": user["id"], 
            "username": user["username"], 
            "role": _normalize_role(user.get("role"), default="user"),
            "permissions": user.get("permissions", {})
        }
        for user in users
    ]


def add_user(username, password, role):
    users = _load_users()
    clean_username = str(username or "").strip()
    if any(str(user.get("username") or "").strip().lower() == clean_username.lower() for user in users):
        return False, f"Username '{clean_username}' already exists."
    normalized_role = _normalize_role(role)
    if not normalized_role:
        return False, "Invalid role."
    users.append(
        {
            "id": str(uuid.uuid4()),
            "username": clean_username,
            "password": password,
            "role": normalized_role,
            "permissions": {
                "view": True,
                "run": normalized_role in ("admin", "ops"),
                "toggle": normalized_role in ("admin", "ops"),
                "sql_download": normalized_role in ("admin", "ops"),
                "sql_update": normalized_role in ("admin", "ops"),
            },
        }
    )
    _save_users(users)
    return True, list_users()


def update_user_permissions(user_id, permissions):
    users = _load_users()
    for user in users:
        if user["id"] == user_id:
            user["permissions"] = {
                "view": _parse_bool(permissions.get("view"), True),
                "run": _parse_bool(permissions.get("run"), False),
                "toggle": _parse_bool(permissions.get("toggle"), False),
                "sql_download": _parse_bool(permissions.get("sql_download"), False),
                "sql_update": _parse_bool(permissions.get("sql_update"), False),
            }
            _save_users(users)
            return True, list_users()
    return False, "User not found."


def update_user_password(user_id, new_password):
    users = _load_users()
    for user in users:
        if user["id"] == user_id:
            user["password"] = new_password
            _save_users(users)
            return True, list_users()
    return False, "User not found."


def delete_user(user_id):
    users = _load_users()
    remaining = [user for user in users if user["id"] != user_id]
    if len(remaining) == len(users):
        return False, "User not found."
    _save_users(remaining)
    projects = load_projects()
    changed = False
    for project in projects:
        assigned = project.get("assigned_user_ids", [])
        if user_id in assigned:
            project["assigned_user_ids"] = [assigned_user_id for assigned_user_id in assigned if assigned_user_id != user_id]
            changed = True
    if changed:
        save_projects(projects)
    return True, list_users()


def add_server(server_data):
    servers = load_servers()
    data = dict(server_data)
    data["id"] = str(uuid.uuid4())
    servers.append(data)
    save_servers(servers)
    return servers


def delete_server(server_id):
    servers = load_servers()
    servers = [server for server in servers if server.get("id") != server_id]
    save_servers(servers)
    projects = load_projects()
    projects = [project for project in projects if project.get("server_id") != server_id]
    save_projects(projects)
    return servers


def get_projects(server_id):
    return get_projects_for_user(None, role="admin", server_id=server_id)


def add_project(name, description, server_id):
    projects = load_projects()
    projects.append(
        {
            "id": str(uuid.uuid4()),
            "name": name,
            "description": description,
            "server_id": server_id,
            "jobs": [],
            "nodes": {},
            "edges": [],
            "assigned_user_ids": [],
        }
    )
    save_projects(projects)
    return get_projects(server_id)


def update_project_pipeline(project_id, jobs, nodes, edges):
    projects = load_projects()
    server_id = None
    updated = False

    for project in projects:
        if project["id"] == project_id:
            project["jobs"] = jobs
            project["nodes"] = nodes
            project["edges"] = edges
            server_id = project["server_id"]
            updated = True
            break

    if updated:
        save_projects(projects)
    return get_projects(server_id) if server_id else []


def update_project_assignments(project_id, user_ids):
    projects = load_projects()
    valid_user_ids = {user["id"] for user in _load_users()}
    server_id = None

    for project in projects:
        if project["id"] == project_id:
            project["assigned_user_ids"] = [
                user_id for user_id in _unique_str_list(user_ids)
                if user_id in valid_user_ids
            ]
            server_id = project["server_id"]
            break

    if server_id is None:
        return []

    save_projects(projects)
    return get_projects(server_id)


def delete_project(project_id):
    projects = load_projects()
    server_id = next((project["server_id"] for project in projects if project["id"] == project_id), None)
    projects = [project for project in projects if project["id"] != project_id]
    save_projects(projects)
    return get_projects(server_id) if server_id else []


def get_sql_templates():
    return load_sql_templates()

def add_sql_template(name, target_table, set_clause_template, where_clause_template):
    templates = load_sql_templates()
    new_template = {
        "id": str(uuid.uuid4()),
        "name": name,
        "target_table": target_table,
        "set_clause_template": set_clause_template,
        "where_clause_template": where_clause_template,
    }
    templates.append(new_template)
    save_sql_templates(templates)
    return get_sql_templates()


def edit_sql_template(template_id, name, target_table, set_clause_template, where_clause_template):
    templates = load_sql_templates()
    for t in templates:
        if t["id"] == template_id:
            t["name"] = name
            t["target_table"] = target_table
            t["set_clause_template"] = set_clause_template
            t["where_clause_template"] = where_clause_template
            break
    save_sql_templates(templates)
    return get_sql_templates()

def delete_sql_template(template_id):
    templates = load_sql_templates()
    templates = [t for t in templates if t["id"] != template_id]
    save_sql_templates(templates)
    return get_sql_templates()
