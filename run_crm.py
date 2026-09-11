import sys
import uvicorn
from backend.config import PORT, HOST

def main():
    print("=" * 60)
    print(f"Starting IndiaMART CRM Python Backend Server")
    print(f"Webapp interface available at: http://localhost:{PORT}")
    print("=" * 60)
    uvicorn.run("backend.main:app", host=HOST, port=PORT, reload=False)

if __name__ == "__main__":
    main()
