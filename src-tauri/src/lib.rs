use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const BROADCAST_PORT: u16 = 13579;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FilePayload {
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub base64_data: String,
    pub is_image: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type")]
enum NetworkPayload {
    Ping {
        id: String,
        username: String,
        status: String,
    },
    Pong {
        id: String,
        username: String,
        status: String,
    },
    Bye {
        id: String,
    },
    Message {
        id: String,
        sender_id: String,
        sender_name: String,
        content: String,
        recipient_id: Option<String>, // None for broadcast (general chat)
        timestamp: u64,
        file_data: Option<FilePayload>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct PeerInfo {
    id: String,
    username: String,
    status: String,
    ip: String,
    last_seen: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct MyInfo {
    id: String,
    username: String,
    status: String,
}

struct AppState {
    my_info: Mutex<MyInfo>,
    peers: Mutex<HashMap<String, PeerInfo>>,
    socket: UdpSocket,
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn create_socket(port: u16) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};

    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;

    #[cfg(all(unix, not(target_os = "solaris")))]
    socket.set_reuse_port(true)?;

    socket.set_broadcast(true)?;

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    socket.bind(&addr.into())?;

    Ok(socket.into())
}

// tauri commands
#[tauri::command]
fn get_peers(state: State<'_, AppState>) -> Vec<PeerInfo> {
    let peers = state.peers.lock().unwrap();
    peers.values().cloned().collect()
}

#[tauri::command]
fn get_my_info(state: State<'_, AppState>) -> MyInfo {
    state.my_info.lock().unwrap().clone()
}

#[tauri::command]
fn update_profile(
    state: State<'_, AppState>,
    username: String,
    status: String,
) -> Result<(), String> {
    let mut my_info = state.my_info.lock().unwrap();
    my_info.username = username.clone();
    my_info.status = status.clone();

    // Broadcast our updated profile immediately
    let ping = NetworkPayload::Ping {
        id: my_info.id.clone(),
        username,
        status,
    };

    if let Ok(serialized) = serde_json::to_string(&ping) {
        let broadcast_addr = SocketAddr::from(([255, 255, 255, 255], BROADCAST_PORT));
        let _ = state.socket.send_to(serialized.as_bytes(), broadcast_addr);
    }

    Ok(())
}

#[tauri::command]
fn send_message(
    state: State<'_, AppState>,
    content: String,
    recipient_id: Option<String>,
    recipient_ip: Option<String>,
    file_data: Option<FilePayload>,
) -> Result<NetworkPayload, String> {
    let my_info = state.my_info.lock().unwrap();
    
    let msg = NetworkPayload::Message {
        id: uuid::Uuid::new_v4().to_string(),
        sender_id: my_info.id.clone(),
        sender_name: my_info.username.clone(),
        content,
        recipient_id,
        timestamp: current_timestamp(),
        file_data,
    };

    if let Ok(serialized) = serde_json::to_string(&msg) {
        if let Some(ip) = recipient_ip {
            // Direct message unicast
            if let Ok(addr) = format!("{}:{}", ip, BROADCAST_PORT).parse::<SocketAddr>() {
                let _ = state.socket.send_to(serialized.as_bytes(), addr);
                return Ok(msg);
            }
        }
        // Fallback or broadcast channel
        let broadcast_addr = SocketAddr::from(([255, 255, 255, 255], BROADCAST_PORT));
        let _ = state.socket.send_to(serialized.as_bytes(), broadcast_addr);
    }

    Ok(msg)
}

// Background network listener task
fn start_network_listener(app_handle: AppHandle, socket: UdpSocket) {
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 65535];
        loop {
            if let Ok((amt, src)) = socket.recv_from(&mut buf) {
                let data = &buf[..amt];
                if let Ok(payload) = serde_json::from_slice::<NetworkPayload>(data) {
                    let state = app_handle.state::<AppState>();
                    let my_id = state.my_info.lock().unwrap().id.clone();
                    let my_username = state.my_info.lock().unwrap().username.clone();
                    let my_status = state.my_info.lock().unwrap().status.clone();

                    let sender_ip = src.ip().to_string();

                    match payload {
                        NetworkPayload::Ping { id, username, status } => {
                            if id != my_id {
                                // Add/Update peer
                                {
                                    let mut peers = state.peers.lock().unwrap();
                                    peers.insert(
                                        id.clone(),
                                        PeerInfo {
                                            id: id.clone(),
                                            username: username.clone(),
                                            status: status.clone(),
                                            ip: sender_ip.clone(),
                                            last_seen: current_timestamp(),
                                        },
                                    );
                                }
                                let _ = app_handle.emit("peers-updated", ());

                                // Reply with Pong
                                let pong = NetworkPayload::Pong {
                                    id: my_id.clone(),
                                    username: my_username,
                                    status: my_status,
                                };
                                if let Ok(serialized) = serde_json::to_string(&pong) {
                                    let _ = socket.send_to(serialized.as_bytes(), src);
                                }
                            }
                        }
                        NetworkPayload::Pong { id, username, status } => {
                            if id != my_id {
                                {
                                    let mut peers = state.peers.lock().unwrap();
                                    peers.insert(
                                        id.clone(),
                                        PeerInfo {
                                            id,
                                            username,
                                            status,
                                            ip: sender_ip,
                                            last_seen: current_timestamp(),
                                        },
                                    );
                                }
                                let _ = app_handle.emit("peers-updated", ());
                            }
                        }
                        NetworkPayload::Bye { id } => {
                            if id != my_id {
                                {
                                    let mut peers = state.peers.lock().unwrap();
                                    peers.remove(&id);
                                }
                                let _ = app_handle.emit("peers-updated", ());
                            }
                        }
                        NetworkPayload::Message {
                            id,
                            sender_id,
                            sender_name,
                            content,
                            recipient_id,
                            timestamp,
                            file_data,
                        } => {
                            // Forward message to frontend if it's general, addressed to us, sent by us, or is a group message
                            let is_group = recipient_id.as_ref().map(|r| r.starts_with("group-")).unwrap_or(false);
                            if recipient_id.is_none() || recipient_id.as_ref() == Some(&my_id) || sender_id == my_id || is_group {
                                let _ = app_handle.emit(
                                    "message-received",
                                    NetworkPayload::Message {
                                        id,
                                        sender_id,
                                        sender_name,
                                        content,
                                        recipient_id,
                                        timestamp,
                                        file_data,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    });
}

// Background peer cleanup task (runs every 5s, drops peers not seen for 15s)
fn start_peer_cleanup(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            let state = app_handle.state::<AppState>();
            let now = current_timestamp();
            let mut changed = false;

            {
                let mut peers = state.peers.lock().unwrap();
                let before_count = peers.len();
                peers.retain(|_, peer| {
                    // Retain if last seen within 15 seconds
                    now - peer.last_seen < 15
                });
                if peers.len() != before_count {
                    changed = true;
                }
            }

            if changed {
                let _ = app_handle.emit("peers-updated", ());
            }
        }
    });
}

// Background ping broadcaster (pings every 6 seconds to keep presence alive)
fn start_ping_broadcaster(app_handle: AppHandle, socket: UdpSocket) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app_handle.state::<AppState>();
            let my_info = state.my_info.lock().unwrap().clone();
            
            let ping = NetworkPayload::Ping {
                id: my_info.id,
                username: my_info.username,
                status: my_info.status,
            };

            if let Ok(serialized) = serde_json::to_string(&ping) {
                let broadcast_addr = SocketAddr::from(([255, 255, 255, 255], BROADCAST_PORT));
                let _ = socket.send_to(serialized.as_bytes(), broadcast_addr);
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(6)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let socket = create_socket(BROADCAST_PORT).expect("Failed to bind UDP socket");
    let listener_socket = socket.try_clone().expect("Failed to clone UDP socket");
    let broadcaster_socket = socket.try_clone().expect("Failed to clone UDP socket");

    // Generate a random UUID for the current session or device
    let my_id = uuid::Uuid::new_v4().to_string();
    // Default username is "User-" + last 4 characters of UUID
    let my_username = format!("User-{}", &my_id[..4]);

    let initial_my_info = MyInfo {
        id: my_id,
        username: my_username,
        status: "online".to_string(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            
            app.manage(AppState {
                my_info: Mutex::new(initial_my_info),
                peers: Mutex::new(HashMap::new()),
                socket,
            });

            // Start background tasks
            start_network_listener(app_handle.clone(), listener_socket);
            start_ping_broadcaster(app_handle.clone(), broadcaster_socket);
            start_peer_cleanup(app_handle);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Send goodbye message on exit
                let state = window.state::<AppState>();
                let my_info = state.my_info.lock().unwrap().clone();
                let bye = NetworkPayload::Bye { id: my_info.id };
                if let Ok(serialized) = serde_json::to_string(&bye) {
                    let broadcast_addr = SocketAddr::from(([255, 255, 255, 255], BROADCAST_PORT));
                    let _ = state.socket.send_to(serialized.as_bytes(), broadcast_addr);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_peers,
            get_my_info,
            update_profile,
            send_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
