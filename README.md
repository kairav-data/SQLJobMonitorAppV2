# 🗄️ SQL Job Monitor

A cross-platform **Windows desktop application** for monitoring, managing, and interacting with SQL Server Agent Jobs — built with Python and CustomTkinter.

---

## ✨ Features

- **Multi-server support** — connect to and switch between multiple SQL Server instances from a single sidebar
- **Live job dashboard** — view all SQL Agent Jobs with real-time status, last run time, and next scheduled run
- **Run jobs on demand** — trigger any SQL Agent Job directly from the UI with a single click
- **Enable / disable jobs** — toggle job scheduling with an inline switch
- **Job history** — inspect detailed execution history for any job via a modal view
- **Search & sort** — filter jobs by name or description, and sort by any column
- **Stats bar** — at-a-glance counts of succeeded, failed, and running jobs
- **Role-based access** — `admin` users can add/remove servers and manage jobs; standard users get a read-and-run view
- **Toast notifications** — non-intrusive success/error feedback after every action
- **Dark / light mode** — automatic theme detection via `darkdetect`
- **Packaged as a standalone `.exe`** — distributed via PyInstaller with no Python installation required

---

## 🖥️ Tech Stack

| Layer | Library |
|---|---|
| UI Framework | [CustomTkinter](https://github.com/TomSchimansky/CustomTkinter) 5.2.2 |
| SQL Server connectivity | [pyodbc](https://github.com/mkleehammer/pyodbc) 5.3.0 |
| Theme detection | [darkdetect](https://github.com/albertosottile/darkdetect) 0.8.0 |
| Packaging | [PyInstaller](https://pyinstaller.org/) 6.19.0 |

---

## 📁 Project Structure

```
SQLJobMonitorApp/
├── main.py            # App entry point — login screen, sidebar, main window, job list
├── database.py        # Local persistence — server configs, user authentication
├── sql_agent.py       # SQL Server Agent bridge — fetch/run/toggle/history via pyodbc
├── ui_components.py   # Reusable widgets — JobRow, StatsBar, AddServerModal, JobHistoryModal
├── requirements.txt   # Python dependencies
└── build.bat          # PyInstaller build script for Windows .exe
```

---

## 🚀 Getting Started

### Prerequisites

- **Windows** (required — uses Windows-only SQL Server ODBC drivers)
- Python 3.10 or later
- [Microsoft ODBC Driver for SQL Server](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server) installed

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/kairav-data/SQLJobMonitorApp.git
cd SQLJobMonitorApp

# 2. Create and activate a virtual environment (recommended)
python -m venv venv
venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run the app
python main.py
```

### Build a standalone executable

```bash
build.bat
```

The packaged `.exe` will appear in the `dist/` folder and can be distributed without a Python runtime.

---

## 🔑 Authentication

The app presents a login screen on startup. Users are authenticated against the application storage configured in `database.py`.

- Without shared app-database configuration, users / servers / projects are stored in local JSON files under `%APPDATA%\\SQLJobMonitor`
- With shared SQL Server app-database configuration, all installed EXEs can use the same users / servers / pipeline data over the network

Two roles are supported:

| Role | Permissions |
|---|---|
| `admin` | Add / remove servers, run jobs, enable/disable jobs, view history |
| `user` | View jobs, run jobs, view history |

---

## 🖱️ Usage

1. **Sign in** with your username and password.
2. **Select a server** from the left sidebar. Admins can add new servers using the **+** button.
3. The job list loads automatically — showing job name, status, last run, and next scheduled run.
4. Use the **search box** to filter jobs or click any column header to sort.
5. Click **▶ Run** on any job row to execute it immediately.
6. Use the **toggle switch** to enable or disable a job's schedule.
7. Click the **history** button on a row to open a detailed execution history modal.
8. Use **↻ Refresh** to reload the job list at any time.
9. Click **Log Out** at the bottom of the sidebar to return to the login screen.

---

## ⚙️ Adding a SQL Server

Admins can register a new server by clicking **+** in the sidebar:

- **Alias** — a friendly display name
- **Server** — hostname or IP of the SQL Server instance
- **Database** — target database name
- **Authentication** — Windows Authentication or SQL login credentials

Connection is verified via `sql_agent.py` before the server is saved.

## Shared App Database

To share users, monitored servers, and project pipeline data across multiple installed EXEs:

1. Copy `app_db_config.example.json` to `app_db_config.json`
2. Place `app_db_config.json` next to the built `.exe`
3. Fill in your SQL Server app-database connection details
4. Start the app from each machine using the same shared database

When `app_db_config.json` is present and `backend` is set to `sqlserver`, the app automatically creates:

- `dbo.app_users`
- `dbo.app_servers`
- `dbo.app_projects`

Notes:

- Set `bootstrap_from_local` to `true` only on the machine you want to use for initial migration from local JSON files
- After the first migration, keep `bootstrap_from_local` as `false` on other machines
- If the config file is missing, the app falls back to machine-local JSON storage
- When running from source (not a frozen `.exe`), the app can also read `app_db_config.example.json` directly for shared-storage setup
- The dashboard status bar shows whether the app is using shared SQL tables or local JSON fallback, including the current SQL connection error when applicable

---

## 🛠️ Development Notes

- All database / SQL operations run on **background threads** to keep the UI responsive.
- `ui_components.py` contains all reusable widgets; extend it to add new columns or modal views.
- To add new user accounts or change role assignments, modify the `database.py` authentication logic.
- The app uses CustomTkinter's dark mode by default (`ctk.set_appearance_mode("dark")`).

---

## 📋 Requirements

```
customtkinter==5.2.2
darkdetect==0.8.0
pyodbc==5.3.0
pyinstaller==6.19.0
pyinstaller-hooks-contrib==2026.4
altgraph==0.17.5
pefile==2024.8.26
pywin32-ctypes==0.2.3
packaging==26.1
```

---

## 📄 License

This project is open source. See [LICENSE](LICENSE) for details.

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request
