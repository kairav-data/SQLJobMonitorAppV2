import pyodbc
from datetime import datetime, timedelta


def build_conn_string(server, driver='{ODBC Driver 17 for SQL Server}'):
    address = server.get('address')
    instance = server.get('instance')
    user = server.get('user')
    password = server.get('password')
    server_str = f"{address}\\{instance}" if instance else address
    if user and password:
        return f"DRIVER={driver};SERVER={server_str};DATABASE=msdb;UID={user};PWD={password};TrustServerCertificate=yes;"
    return f"DRIVER={driver};SERVER={server_str};DATABASE=msdb;Trusted_Connection=yes;TrustServerCertificate=yes;"


def get_connection(server):
    """Try modern driver first, fallback to legacy."""
    conn_str = build_conn_string(server)
    try:
        return pyodbc.connect(conn_str, timeout=5)
    except Exception:
        fallback = build_conn_string(server, driver='{SQL Server}')
        return pyodbc.connect(fallback, timeout=5)


def test_connection(server):
    try:
        conn = get_connection(server)
        conn.close()
        return True, "Connection successful"
    except Exception as e:
        return False, str(e)


def fetch_jobs(server):
    try:
        conn = get_connection(server)
    except Exception as e:
        return False, str(e)

    cursor = conn.cursor()
    query = """
    SELECT 
        j.job_id AS id,
        j.name,
        j.enabled,
        ISNULL(j.description, '') AS description,
        CASE 
            -- If job has started but not stopped in the current session → actively running
            WHEN ja.start_execution_date IS NOT NULL AND ja.stop_execution_date IS NULL THEN 'In Progress'
            WHEN jh.run_status = 0 THEN 'Failed'
            WHEN jh.run_status = 1 THEN 'Succeeded'
            WHEN jh.run_status = 2 THEN 'Retry'
            WHEN jh.run_status = 3 THEN 'Canceled'
            WHEN jh.run_status = 4 THEN 'In Progress'
            ELSE 'Unknown'
        END AS last_run_status,
        ja.start_execution_date,
        ja.stop_execution_date,
        ja.next_scheduled_run_date,
        CASE WHEN ja.start_execution_date IS NOT NULL AND ja.stop_execution_date IS NOT NULL
             THEN DATEDIFF(SECOND, ja.start_execution_date, ja.stop_execution_date)
             ELSE NULL END AS duration_seconds
    FROM msdb.dbo.sysjobs j
    LEFT JOIN msdb.dbo.sysjobactivity ja ON ja.job_id = j.job_id 
        AND ja.session_id = (SELECT TOP 1 session_id FROM msdb.dbo.syssessions ORDER BY agent_start_date DESC)
    LEFT JOIN msdb.dbo.sysjobhistory jh ON j.job_id = jh.job_id
        AND jh.instance_id = (SELECT MAX(instance_id) FROM msdb.dbo.sysjobhistory WHERE job_id = j.job_id AND step_id = 0)
    ORDER BY j.name
    """
    try:
        cursor.execute(query)
        rows = cursor.fetchall()
        jobs = []
        for row in rows:
            jobs.append({
                "job_id": row.id,
                "name": row.name,
                "enabled": row.enabled,
                "description": row.description,
                "last_run_status": row.last_run_status,
                "start_execution_date": row.start_execution_date,
                "stop_execution_date": row.stop_execution_date,
                "next_scheduled_run_date": row.next_scheduled_run_date,
                "duration_seconds": row.duration_seconds,
            })
        conn.close()
        return True, jobs
    except Exception as e:
        conn.close()
        return False, str(e)


def fetch_jobs_by_date(server, date_str):
    """Fetch jobs that ran on a specific date, or are scheduled to run on it."""
    try:
        conn = get_connection(server)
    except Exception as e:
        return False, str(e)

    run_date_int = int(date_str.replace('-', ''))

    cursor = conn.cursor()
    query = """
    SELECT 
        j.job_id AS id,
        j.name,
        j.enabled,
        ISNULL(j.description, '') AS description,
        CASE 
            WHEN jh.run_status = 0 THEN 'Failed'
            WHEN jh.run_status = 1 THEN 'Succeeded'
            WHEN jh.run_status = 2 THEN 'Retry'
            WHEN jh.run_status = 3 THEN 'Canceled'
            WHEN jh.run_status = 4 THEN 'In Progress'
            ELSE 'Unknown'
        END AS last_run_status,
        CASE WHEN jh.instance_id IS NOT NULL THEN msdb.dbo.agent_datetime(jh.run_date, jh.run_time) ELSE ja.start_execution_date END AS start_execution_date,
        ja.stop_execution_date,
        ja.next_scheduled_run_date,
        CASE WHEN jh.instance_id IS NOT NULL THEN 
             (jh.run_duration / 10000 * 3600) + ((jh.run_duration % 10000) / 100 * 60) + (jh.run_duration % 100)
             ELSE 
             CASE WHEN ja.start_execution_date IS NOT NULL AND ja.stop_execution_date IS NOT NULL
                  THEN DATEDIFF(SECOND, ja.start_execution_date, ja.stop_execution_date)
                  ELSE NULL END
             END AS duration_seconds
    FROM msdb.dbo.sysjobs j
    LEFT JOIN msdb.dbo.sysjobhistory jh ON j.job_id = jh.job_id
        AND jh.instance_id = (
            SELECT MAX(instance_id) 
            FROM msdb.dbo.sysjobhistory 
            WHERE job_id = j.job_id AND step_id = 0 AND run_date = ?
        )
    LEFT JOIN msdb.dbo.sysjobactivity ja ON ja.job_id = j.job_id 
        AND ja.session_id = (SELECT TOP 1 session_id FROM msdb.dbo.syssessions ORDER BY agent_start_date DESC)
    WHERE jh.instance_id IS NOT NULL 
       OR (ja.next_scheduled_run_date IS NOT NULL AND CONVERT(VARCHAR(10), ja.next_scheduled_run_date, 120) = ?)
    ORDER BY j.name
    """
    try:
        cursor.execute(query, run_date_int, date_str)
        rows = cursor.fetchall()
        jobs = []
        for row in rows:
            jobs.append({
                "job_id": row.id,
                "name": row.name,
                "enabled": row.enabled,
                "description": row.description,
                "last_run_status": row.last_run_status,
                "start_execution_date": row.start_execution_date,
                "stop_execution_date": row.stop_execution_date,
                "next_scheduled_run_date": row.next_scheduled_run_date,
                "duration_seconds": row.duration_seconds,
            })
        conn.close()
        return True, jobs
    except Exception as e:
        conn.close()
        return False, str(e)


def fetch_job_history(server, job_name, limit=20):
    try:
        conn = get_connection(server)
    except Exception as e:
        return False, str(e)

    cursor = conn.cursor()
    query = f"""
        SELECT TOP ({limit})
            CASE 
                WHEN jh.run_status = 0 THEN 'Failed'
                WHEN jh.run_status = 1 THEN 'Succeeded'
                WHEN jh.run_status = 2 THEN 'Retry'
                WHEN jh.run_status = 3 THEN 'Canceled'
                WHEN jh.run_status = 4 THEN 'In Progress'
                ELSE 'Unknown'
            END AS status,
            msdb.dbo.agent_datetime(jh.run_date, jh.run_time) AS run_datetime,
            (jh.run_duration / 10000 * 3600) + ((jh.run_duration % 10000) / 100 * 60) + (jh.run_duration % 100) AS duration_seconds,
            jh.message AS job_message,
            (
                SELECT TOP 1 s.message 
                FROM msdb.dbo.sysjobhistory s 
                WHERE s.job_id = jh.job_id 
                  AND s.step_id > 0 
                  AND s.run_status = 0 
                  AND s.instance_id < jh.instance_id
                  AND s.instance_id > ISNULL((
                      SELECT MAX(prev.instance_id) 
                      FROM msdb.dbo.sysjobhistory prev 
                      WHERE prev.job_id = jh.job_id 
                        AND prev.step_id = 0 
                        AND prev.instance_id < jh.instance_id
                  ), 0)
                ORDER BY s.instance_id DESC
            ) AS step_error_message
        FROM msdb.dbo.sysjobhistory jh
        JOIN msdb.dbo.sysjobs j ON j.job_id = jh.job_id
        WHERE j.name = ? AND jh.step_id = 0
        ORDER BY jh.instance_id DESC
    """

    try:
        cursor.execute(query, job_name)
        rows = cursor.fetchall()
        history = []
        for row in rows:
            msg = row.job_message
            if row.status == 'Failed' and row.step_error_message:
                msg = f"{row.job_message}\n\nError Detail:\n{row.step_error_message}"

            history.append({
                "status": row.status,
                "run_datetime": row.run_datetime,
                "duration_seconds": row.duration_seconds,
                "message": msg,
            })
        conn.close()
        return True, history
    except Exception as e:
        conn.close()
        return False, str(e)


def fetch_job_schedules(server):
    """
    Returns a dict mapping job_name -> list of upcoming datetime objects
    based on sysjobactivity.next_scheduled_run_date (already fetched in jobs),
    plus sysjobschedules for richer schedule info.
    Returns (True, {job_name: [datetime, ...]}) or (False, error_str).
    """
    try:
        conn = get_connection(server)
    except Exception as e:
        return False, str(e)

    cursor = conn.cursor()
    query = """
    SELECT
        j.name AS job_name,
        ja.next_scheduled_run_date
    FROM msdb.dbo.sysjobs j
    LEFT JOIN msdb.dbo.sysjobactivity ja ON ja.job_id = j.job_id
        AND ja.session_id = (
            SELECT TOP 1 session_id FROM msdb.dbo.syssessions ORDER BY agent_start_date DESC
        )
    WHERE ja.next_scheduled_run_date IS NOT NULL
    ORDER BY j.name
    """
    try:
        cursor.execute(query)
        rows = cursor.fetchall()
        schedules = {}
        for row in rows:
            name = row.job_name
            dt = row.next_scheduled_run_date
            if dt:
                schedules.setdefault(name, []).append(dt)
        conn.close()
        return True, schedules
    except Exception as e:
        conn.close()
        return False, str(e)


def fetch_job_activity_dates(server, lookback_days=180):
    """Return a map of YYYY-MM-DD -> {count, jobs[]} for recent job executions."""
    try:
        conn = get_connection(server)
    except Exception as e:
        return False, str(e)

    cursor = conn.cursor()
    query = """
    SELECT
        CONVERT(VARCHAR(10), msdb.dbo.agent_datetime(jh.run_date, jh.run_time), 120) AS run_day,
        j.name AS job_name
    FROM msdb.dbo.sysjobhistory jh
    JOIN msdb.dbo.sysjobs j ON j.job_id = jh.job_id
    WHERE jh.step_id = 0
      AND msdb.dbo.agent_datetime(jh.run_date, jh.run_time) >= DATEADD(DAY, ?, GETDATE())
    ORDER BY run_day, j.name
    """

    try:
        cursor.execute(query, -abs(int(lookback_days)))
        rows = cursor.fetchall()
        activity = {}
        for row in rows:
            day = str(row.run_day)
            name = str(row.job_name or "").strip()
            if day not in activity:
                activity[day] = {"count": 0, "jobs": []}
            activity[day]["count"] += 1
            if name and name not in activity[day]["jobs"]:
                activity[day]["jobs"].append(name)
        conn.close()
        return True, activity
    except Exception as e:
        conn.close()
        return False, str(e)


def run_job(server, job_name):
    try:
        conn = get_connection(server)
    except Exception as e:
        return False, str(e)

    try:
        conn.autocommit = True
        cursor = conn.cursor()
        cursor.execute(f"EXEC msdb.dbo.sp_start_job N'{job_name}'")
        conn.close()
        return True, f"Job '{job_name}' started successfully."
    except Exception as e:
        conn.close()
        return False, str(e)


def set_job_enabled(server, job_name, enabled: bool):
    try:
        conn = get_connection(server)
    except Exception as e:
        return False, str(e)

    try:
        conn.autocommit = True
        cursor = conn.cursor()
        proc = "sp_update_job"
        enabled_val = 1 if enabled else 0
        cursor.execute(f"EXEC msdb.dbo.{proc} @job_name=?, @enabled=?", job_name, enabled_val)
        conn.close()
        state = "enabled" if enabled else "disabled"
        return True, f"Job '{job_name}' {state}."
    except Exception as e:
        conn.close()
        return False, str(e)
