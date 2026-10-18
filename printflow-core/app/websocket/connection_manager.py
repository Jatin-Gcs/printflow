import json
from typing import List
from fastapi import WebSocket

class OperatorConnectionManager:
    """Manages active WebSocket connections to broadcast queue events to UI terminals."""

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast_event(self, event_type: str, data: dict) -> None:
        payload = json.dumps({"event": event_type, "payload": data})
        stale = []
        for connection in self.active_connections:
            try:
                await connection.send_text(payload)
            except Exception:
                stale.append(connection)
        for dead in stale:
            self.disconnect(dead)

ws_manager = OperatorConnectionManager()