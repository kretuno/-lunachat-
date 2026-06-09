import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";

interface MyInfo {
  id: string;
  username: string;
  status: string;
  avatar: string;
}

interface PeerInfo {
  id: string;
  username: string;
  status: string;
  ip: string;
  last_seen: number;
  avatar: string;
}

interface GroupInfo {
  id: string;
  name: string;
  passwordHash?: string;
  unlocked?: boolean;
}

interface FilePayload {
  name: string;
  size: number;
  mime_type: string;
  base64_data: string;
  is_image: boolean;
}

interface PollOption {
  id: string;
  text: string;
  votes: string[]; // List of user IDs who voted for this option
}

interface PollPayload {
  id: string;
  question: string;
  options: PollOption[];
}

interface Message {
  id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  recipient_id: string | null;
  timestamp: number;
  isSystem?: boolean;
  file_data?: FilePayload;
  
  // Bulletin extensions
  isBulletin?: boolean;
  expiresAt?: number | null; // Timestamp in seconds

  // Poll extensions
  isPoll?: boolean;
  pollData?: PollPayload;
}

const POPULAR_EMOJIS = [
  "😀", "😂", "😍", "👍", "👎", "🎉", "🔥", "🚀", "❤️", "👀", 
  "💬", "👏", "🌟", "💡", "😢", "😡", "🤔", "👌", "🙏", "⚡"
];

// Helper to compute SHA-256 hash of a string
async function hashPassword(password: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

// Safe UUID Generator for P2P context (falls back if crypto.randomUUID is not available)
function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Compress image using canvas (forces max 400px width/height for P2P transport)
function compressImage(file: File): Promise<{ base64Data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        const MAX_SIZE = 400;
        if (width > height) {
          if (width > MAX_SIZE) {
            height = Math.round((height * MAX_SIZE) / width);
            width = MAX_SIZE;
          }
        } else {
          if (height > MAX_SIZE) {
            width = Math.round((width * MAX_SIZE) / height);
            height = MAX_SIZE;
          }
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const compressedBase64 = canvas.toDataURL("image/jpeg", 0.7); // 70% JPEG quality
          resolve({
            base64Data: compressedBase64,
            mimeType: "image/jpeg",
          });
        } else {
          reject(new Error("Canvas context is null"));
        }
      };
      img.onerror = () => reject(new Error("Failed to load image into element"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("Failed to read file as data url"));
    reader.readAsDataURL(file);
  });
}

// Read raw file as base64 string
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      resolve(e.target?.result as string);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

const PRESET_AVATARS = ["🐱", "🐶", "🦊", "🦁", "🐸", "🐼", "🐻", "🐨", "🐯", "🐰", "🦁", "🦄", "🐙", "🦀", "🦖", "🦊"];

export default function App() {
  const [myInfo, setMyInfo] = useState<MyInfo | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTab, setActiveTab] = useState<string>("#general");
  
  // Timer for tracking expired bulletins
  const [currentTime, setCurrentTime] = useState(Math.floor(Date.now() / 1000));
  
  // Input composer
  const [inputText, setInputText] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  
  // Profile Editor
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [statusInput, setStatusInput] = useState("online");
  const [avatarInput, setAvatarInput] = useState("🐱");

  // Bulletin Board
  const [bulletinOpen, setBulletinOpen] = useState(false);
  const [bulletinText, setBulletinText] = useState("");
  const [bulletinDuration, setBulletinDuration] = useState<number>(0); // 0 = unlimited

  // Group Creator
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState("");
  const [isPasswordProtected, setIsPasswordProtected] = useState(false);
  const [groupPasswordInput, setGroupPasswordInput] = useState("");

  // Password Prompt Modal
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [targetGroupToUnlock, setTargetGroupToUnlock] = useState<GroupInfo | null>(null);
  const [passwordPromptText, setPasswordPromptText] = useState("");
  const [passwordPromptError, setPasswordPromptError] = useState("");

  // Poll Creator
  const [createPollOpen, setCreatePollOpen] = useState(false);
  const [pollQuestionInput, setPollQuestionInput] = useState("");
  const [pollOptionsList, setPollOptionsList] = useState<string[]>(["", ""]);

  // About App Modal
  const [aboutOpen, setAboutOpen] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);

  // Image Preview (Lightbox)
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Set up timer for expired bulletins
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(Math.floor(Date.now() / 1000));
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Load initial info and groups from localStorage
  useEffect(() => {
    async function loadInitialData() {
      try {
        const info = await invoke<MyInfo>("get_my_info");
        setMyInfo(info);
        setUsernameInput(info.username);
        setStatusInput(info.status);
        setAvatarInput(info.avatar || "🐱");

        const activePeers = await invoke<PeerInfo[]>("get_peers");
        setPeers(activePeers);
      } catch (err) {
        console.error("Failed to load initial data", err);
      }
    }

    // Load groups
    const savedGroups = localStorage.getItem("lunachat_groups");
    if (savedGroups) {
      try {
        setGroups(JSON.parse(savedGroups));
      } catch (e) {
        console.error("Failed to parse saved groups", e);
      }
    }

    loadInitialData();
  }, []);

  // Listen to click outside emoji picker to close it
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setEmojiPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Listen to Tauri events
  useEffect(() => {
    let unlistenPeers: (() => void) | null = null;
    let unlistenMessages: (() => void) | null = null;

    async function setupListeners() {
      // 1. Listen to peers-updated event
      unlistenPeers = await listen("peers-updated", async () => {
        const activePeers = await invoke<PeerInfo[]>("get_peers");
        setPeers(activePeers);
      });

      // 2. Listen to message-received event
      unlistenMessages = await listen<any>("message-received", (event) => {
        const rawMsg = event.payload;
        if (!rawMsg) return;

        let content = rawMsg.content || "";
        let isBulletin = false;
        let isSystem = false;
        let isPoll = false;
        let expiresAt: number | null = null;
        let pollData: PollPayload | undefined = undefined;

        // P2P group creation announcement detection via JSON metadata
        if (content.startsWith("[GROUP_CREATE] ")) {
          const jsonStr = content.replace("[GROUP_CREATE] ", "");
          try {
            const meta = JSON.parse(jsonStr);
            const groupId = meta.id;
            const groupName = meta.name;
            const passwordHash = meta.passwordHash;

            setGroups((prev) => {
              if (prev.some((g) => g.id === groupId)) return prev;
              const newGroup: GroupInfo = {
                id: groupId,
                name: groupName,
                passwordHash: passwordHash || undefined,
                unlocked: false,
              };
              const updated = [...prev, newGroup];
              localStorage.setItem("lunachat_groups", JSON.stringify(updated));
              return updated;
            });

            isSystem = true;
            content = `Пользователь ${rawMsg.sender_name} создал группу "${groupName}"${passwordHash ? " [Защищена паролем]" : ""}`;
          } catch (e) {
            console.error("Failed to parse group creation JSON metadata", e);
          }
        } else if (content.startsWith("[BULLETIN] ")) {
          const jsonStr = content.replace("[BULLETIN] ", "");
          try {
            const meta = JSON.parse(jsonStr);
            content = meta.text;
            expiresAt = meta.expiresAt || null;
            isBulletin = true;
          } catch (e) {
            // Fallback for older plaintext format
            content = jsonStr;
            isBulletin = true;
          }
        } else if (content.startsWith("[POLL] ")) {
          const jsonStr = content.replace("[POLL] ", "");
          try {
            pollData = JSON.parse(jsonStr);
            isPoll = true;
            content = `Голосование: ${pollData?.question}`;
          } catch (e) {
            console.error("Failed to parse poll data", e);
          }
        } else if (content.startsWith("[POLL_VOTE] ")) {
          // Vote announcement: don't add to list, just update target poll option
          const jsonStr = content.replace("[POLL_VOTE] ", "");
          try {
            const vote = JSON.parse(jsonStr);
            setMessages((prev) => {
              return prev.map((msg) => {
                if (msg.isPoll && msg.pollData && msg.pollData.id === vote.pollId) {
                  const updatedOptions = msg.pollData.options.map((opt) => {
                    // Remove voter ID from all other options to prevent double voting
                    let newVotes = opt.votes.filter((uid) => uid !== vote.userId);
                    if (opt.id === vote.optionId) {
                      newVotes.push(vote.userId);
                    }
                    return { ...opt, votes: newVotes };
                  });
                  return {
                    ...msg,
                    pollData: { ...msg.pollData, options: updatedOptions }
                  };
                }
                return msg;
              });
            });
          } catch (e) {
            console.error("Failed to parse poll vote", e);
          }
          return; // Skip adding the message to stream
        }

        const newMsg: Message = {
          id: rawMsg.id,
          sender_id: rawMsg.sender_id,
          sender_name: rawMsg.sender_name,
          content,
          recipient_id: rawMsg.recipient_id,
          timestamp: rawMsg.timestamp,
          isBulletin,
          isSystem,
          isPoll,
          expiresAt,
          pollData,
          file_data: rawMsg.file_data || undefined,
        };

        setMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) {
            return prev;
          }
          return [...prev, newMsg];
        });
      });
    }

    setupListeners();

    return () => {
      if (unlistenPeers) unlistenPeers();
      if (unlistenMessages) unlistenMessages();
    };
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeTab]);



  // Handle profile update
  async function handleUpdateProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!usernameInput.trim()) return;

    try {
      await invoke("update_profile", {
        username: usernameInput,
        status: statusInput,
        avatar: avatarInput,
      });
      setMyInfo((prev) => prev ? { ...prev, username: usernameInput, status: statusInput, avatar: avatarInput } : null);
      setIsEditingProfile(false);
    } catch (err) {
      console.error("Failed to update profile", err);
    }
  }

  // Find active chat details
  const activePeer = peers.find((p) => p.id === activeTab);
  const activeGroup = groups.find((g) => g.id === activeTab);

  // Filter messages for current chat view (also filters out expired bulletins)
  const currentMessages = messages.filter((msg) => {
    // Hide expired bulletins
    if (msg.isBulletin && msg.expiresAt && msg.expiresAt < currentTime) {
      return false;
    }

    if (activeTab === "#general") {
      return msg.recipient_id === null;
    } else if (activeTab.startsWith("group-")) {
      return msg.recipient_id === activeTab;
    } else {
      if (!myInfo) return false;
      return (
        (msg.sender_id === myInfo.id && msg.recipient_id === activeTab) ||
        (msg.sender_id === activeTab && msg.recipient_id === myInfo.id)
      );
    }
  });

  // Handle message sending (text)
  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!inputText.trim() || !myInfo) return;

    let recipientId: string | null = null;
    let recipientIp: string | null = null;

    if (activeTab.startsWith("group-")) {
      recipientId = activeTab;
    } else if (activeTab !== "#general") {
      recipientId = activeTab;
      recipientIp = activePeer ? activePeer.ip : null;
    }

    try {
      const sentMsgRaw = await invoke<any>("send_message", {
        content: inputText,
        recipientId,
        recipientIp,
        fileData: null,
      });

      const sentMsg: Message = {
        id: sentMsgRaw.id,
        sender_id: sentMsgRaw.sender_id,
        sender_name: sentMsgRaw.sender_name,
        content: sentMsgRaw.content,
        recipient_id: sentMsgRaw.recipient_id,
        timestamp: sentMsgRaw.timestamp,
        isBulletin: false,
        file_data: sentMsgRaw.file_data || undefined,
      };

      setMessages((prev) => {
        if (prev.some((m) => m.id === sentMsg.id)) {
          return prev;
        }
        return [...prev, sentMsg];
      });

      setInputText("");
    } catch (err) {
      console.error("Failed to send message", err);
    }
  }

  // Handle file choice and transmission
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !myInfo) return;

    const isImage = file.type.startsWith("image/");
    const maxBytes = 40 * 1024; // 40 KB limit for non-image files due to UDP limit

    let base64Data = "";
    let mimeType = file.type || "application/octet-stream";

    if (isImage) {
      try {
        const result = await compressImage(file);
        base64Data = result.base64Data;
        mimeType = result.mimeType;
      } catch (err) {
        alert("Ошибка сжатия изображения: " + err);
        return;
      }
    } else {
      if (file.size > maxBytes) {
        alert(`Файлы больше 40 КБ нельзя передать напрямую без сервера. Пожалуйста, отправляйте только изображения (они сжимаются автоматически) или небольшие документы до 40 КБ.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      try {
        base64Data = await readFileAsBase64(file);
      } catch (err) {
        alert("Ошибка чтения файла: " + err);
        return;
      }
    }

    let recipientId: string | null = null;
    let recipientIp: string | null = null;

    if (activeTab.startsWith("group-")) {
      recipientId = activeTab;
    } else if (activeTab !== "#general") {
      recipientId = activeTab;
      recipientIp = activePeer ? activePeer.ip : null;
    }

    const filePayload: FilePayload = {
      name: file.name,
      size: file.size,
      mime_type: mimeType,
      base64_data: base64Data,
      is_image: isImage,
    };

    try {
      const sentMsgRaw = await invoke<any>("send_message", {
        content: isImage ? `Отправил изображение: ${file.name}` : `Отправил файл: ${file.name}`,
        recipientId,
        recipientIp,
        fileData: filePayload,
      });

      const sentMsg: Message = {
        id: sentMsgRaw.id,
        sender_id: sentMsgRaw.sender_id,
        sender_name: sentMsgRaw.sender_name,
        content: sentMsgRaw.content,
        recipient_id: sentMsgRaw.recipient_id,
        timestamp: sentMsgRaw.timestamp,
        isBulletin: false,
        file_data: sentMsgRaw.file_data || undefined,
      };

      setMessages((prev) => {
        if (prev.some((m) => m.id === sentMsg.id)) {
          return prev;
        }
        return [...prev, sentMsg];
      });

      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      alert("Ошибка отправки файла по локальной сети: " + err);
    }
  }

  // Save base64 file to download directory
  function downloadBase64File(fileData: FilePayload) {
    const link = document.createElement("a");
    link.href = fileData.base64_data;
    link.download = fileData.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Handle bulletin posting with expiration support
  async function handlePostBulletin(e: React.FormEvent) {
    e.preventDefault();
    if (!bulletinText.trim() || !myInfo) return;

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiresAt = bulletinDuration > 0 ? currentTimestamp + bulletinDuration : null;

    const bulletinMeta = {
      text: bulletinText,
      expiresAt: expiresAt,
    };

    try {
      const sentMsgRaw = await invoke<any>("send_message", {
        content: `[BULLETIN] ${JSON.stringify(bulletinMeta)}`,
        recipientId: null,
        recipientIp: null,
        fileData: null,
      });

      const sentMsg: Message = {
        id: sentMsgRaw.id,
        sender_id: sentMsgRaw.sender_id,
        sender_name: sentMsgRaw.sender_name,
        content: bulletinText,
        recipient_id: null,
        timestamp: sentMsgRaw.timestamp,
        isBulletin: true,
        expiresAt: expiresAt,
      };

      setMessages((prev) => {
        if (prev.some((m) => m.id === sentMsg.id)) {
          return prev;
        }
        return [...prev, sentMsg];
      });

      setBulletinText("");
      setBulletinDuration(0);
      setBulletinOpen(false);
    } catch (err) {
      console.error("Failed to post bulletin", err);
    }
  }

  // Handle group creation with password support
  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!groupNameInput.trim() || !myInfo) return;

    const newGroupId = `group-${generateUUID()}`;
    let passwordHash = "";

    if (isPasswordProtected && groupPasswordInput.trim()) {
      passwordHash = await hashPassword(groupPasswordInput.trim());
    }

    const groupMeta = {
      id: newGroupId,
      name: groupNameInput,
      passwordHash: passwordHash || null,
    };

    try {
      // 1. Send network message announcing the group creation in JSON format
      await invoke("send_message", {
        content: `[GROUP_CREATE] ${JSON.stringify(groupMeta)}`,
        recipientId: null,
        recipientIp: null,
        fileData: null,
      });

      // 2. Add group to local list and save to localStorage (unlocked = true for creator)
      const newGroup: GroupInfo = {
        id: newGroupId,
        name: groupNameInput,
        passwordHash: passwordHash || undefined,
        unlocked: true,
      };
      setGroups((prev) => {
        const updated = [...prev, newGroup];
        localStorage.setItem("lunachat_groups", JSON.stringify(updated));
        return updated;
      });

      // 3. Switch tab and clean up
      setActiveTab(newGroupId);
      setGroupNameInput("");
      setGroupPasswordInput("");
      setIsPasswordProtected(false);
      setCreateGroupOpen(false);
    } catch (err) {
      console.error("Failed to create group", err);
    }
  }

  // Handle group click with password verification
  function handleGroupClick(group: GroupInfo) {
    if (group.passwordHash && !group.unlocked) {
      setTargetGroupToUnlock(group);
      setPasswordPromptText("");
      setPasswordPromptError("");
      setPasswordPromptOpen(true);
    } else {
      setActiveTab(group.id);
    }
  }

  // Handle password unlock submission
  async function handleUnlockGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!targetGroupToUnlock) return;

    const inputHash = await hashPassword(passwordPromptText.trim());
    if (inputHash === targetGroupToUnlock.passwordHash) {
      setGroups((prev) => {
        const updated = prev.map((g) => {
          if (g.id === targetGroupToUnlock.id) {
            return { ...g, unlocked: true };
          }
          return g;
        });
        localStorage.setItem("lunachat_groups", JSON.stringify(updated));
        return updated;
      });

      setActiveTab(targetGroupToUnlock.id);
      setPasswordPromptOpen(false);
      setTargetGroupToUnlock(null);
    } else {
      setPasswordPromptError("Неверный пароль!");
    }
  }

  // Handle Poll creation and broadcast
  async function handleCreatePoll(e: React.FormEvent) {
    e.preventDefault();
    if (!pollQuestionInput.trim() || !myInfo) return;

    // Filter out empty options
    const options = pollOptionsList
      .filter((opt) => opt.trim() !== "")
      .map((opt, index) => ({
        id: `opt-${index}`,
        text: opt,
        votes: []
      }));

    if (options.length < 2) {
      alert("Необходимо заполнить как минимум 2 варианта ответа!");
      return;
    }

    const pollId = `poll-${generateUUID()}`;
    const pollPayload: PollPayload = {
      id: pollId,
      question: pollQuestionInput,
      options
    };

    let recipientId: string | null = null;
    let recipientIp: string | null = null;

    if (activeTab.startsWith("group-")) {
      recipientId = activeTab;
    } else if (activeTab !== "#general") {
      recipientId = activeTab;
      recipientIp = activePeer ? activePeer.ip : null;
    }

    try {
      const sentMsgRaw = await invoke<any>("send_message", {
        content: `[POLL] ${JSON.stringify(pollPayload)}`,
        recipientId,
        recipientIp,
        fileData: null,
      });

      const sentMsg: Message = {
        id: sentMsgRaw.id,
        sender_id: sentMsgRaw.sender_id,
        sender_name: sentMsgRaw.sender_name,
        content: `Голосование: ${pollQuestionInput}`,
        recipient_id: sentMsgRaw.recipient_id,
        timestamp: sentMsgRaw.timestamp,
        isPoll: true,
        pollData: pollPayload
      };

      setMessages((prev) => {
        if (prev.some((m) => m.id === sentMsg.id)) {
          return prev;
        }
        return [...prev, sentMsg];
      });

      // Clear creator state
      setPollQuestionInput("");
      setPollOptionsList(["", ""]);
      setCreatePollOpen(false);
    } catch (err) {
      alert("Ошибка создания голосования: " + err);
    }
  }

  // Handle voting click in a poll
  async function handleVote(pollId: string, optionId: string) {
    if (!myInfo) return;

    let recipientId: string | null = null;
    let recipientIp: string | null = null;

    if (activeTab.startsWith("group-")) {
      recipientId = activeTab;
    } else if (activeTab !== "#general") {
      recipientId = activeTab;
      recipientIp = activePeer ? activePeer.ip : null;
    }

    const votePayload = {
      pollId,
      optionId,
      userId: myInfo.id
    };

    try {
      // 1. Broadcast the vote over the network
      await invoke("send_message", {
        content: `[POLL_VOTE] ${JSON.stringify(votePayload)}`,
        recipientId,
        recipientIp,
        fileData: null,
      });

      // 2. Perform local optimistic update so UI is instant
      setMessages((prev) => {
        return prev.map((msg) => {
          if (msg.isPoll && msg.pollData && msg.pollData.id === pollId) {
            const updatedOptions = msg.pollData.options.map((opt) => {
              // Remove voter ID from all options first, to prevent double votes
              let newVotes = opt.votes.filter((uid) => uid !== myInfo.id);
              if (opt.id === optionId) {
                newVotes.push(myInfo.id);
              }
              return { ...opt, votes: newVotes };
            });
            return {
              ...msg,
              pollData: { ...msg.pollData, options: updatedOptions }
            };
          }
          return msg;
        });
      });
    } catch (err) {
      console.error("Failed to vote", err);
    }
  }

  // Dynamically add a poll option input field
  function addPollOptionField() {
    if (pollOptionsList.length >= 6) {
      alert("Максимум 6 вариантов ответа!");
      return;
    }
    setPollOptionsList([...pollOptionsList, ""]);
  }

  // Update specific poll option input value
  function updatePollOptionValue(index: number, value: string) {
    const updated = [...pollOptionsList];
    updated[index] = value;
    setPollOptionsList(updated);
  }

  // Remove specific poll option input
  function removePollOptionField(index: number) {
    if (pollOptionsList.length <= 2) {
      alert("Необходимо заполнить как минимум 2 варианта ответа!");
      return;
    }
    const updated = pollOptionsList.filter((_, i) => i !== index);
    setPollOptionsList(updated);
  }

  // Add emoji to message input
  function handleEmojiClick(emoji: string) {
    setInputText((prev) => prev + emoji);
    setEmojiPickerOpen(false);
  }

  // Format timestamp (HH:MM:SS)
  function formatTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  const updateRef = useRef<any>(null);

  async function handleCheckForUpdates() {
    setCheckingUpdates(true);
    setUpdateStatus("Поиск обновлений...");
    setHasUpdate(false);
    updateRef.current = null;

    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setHasUpdate(true);
        setUpdateStatus(`Доступна новая версия: ${update.version}`);
      } else {
        setUpdateStatus("У вас установлена последняя версия.");
      }
    } catch (err) {
      console.error("Failed to check for updates", err);
      setUpdateStatus("Ошибка при проверке обновлений.");
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function handleInstallUpdate() {
    if (!updateRef.current) return;
    setCheckingUpdates(true);
    setUpdateStatus("Загрузка обновления...");

    try {
      let downloaded = 0;
      let contentLength = 0;
      await updateRef.current.downloadAndInstall((event: any) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength || 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              const percent = Math.round((downloaded / contentLength) * 100);
              setUpdateStatus(`Загрузка... ${percent}%`);
            } else {
              setUpdateStatus(`Загрузка... ${(downloaded / 1024).toFixed(0)} КБ`);
            }
            break;
          case 'Finished':
            setUpdateStatus("Установка...");
            break;
        }
      });

      setUpdateStatus("Обновление установлено! Перезапуск...");
      setTimeout(async () => {
        try {
          await relaunch();
        } catch (e) {
          console.error("Failed to relaunch", e);
          setUpdateStatus("Пожалуйста, перезапустите вручную.");
        }
      }, 1500);
    } catch (err) {
      console.error("Failed to install update", err);
      setUpdateStatus(`Ошибка установки: ${err}`);
      setCheckingUpdates(false);
    }
  }

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className="sidebar">
        {/* My Profile */}
        <div className="my-profile">
          {myInfo && !isEditingProfile ? (
            <div className="profile-card">
              <div className="avatar-wrapper">
                <div className="avatar" style={{ fontSize: "24px", display: "flex", alignItems: "center", justifyContent: "center" }}>{myInfo.avatar || "🐱"}</div>
                <span className={`presence-dot presence-${myInfo.status}`} />
              </div>
              <div className="profile-info">
                <div className="profile-name-row">
                  <div className="profile-name" title={myInfo.username}>{myInfo.username}</div>
                  <button className="edit-btn" onClick={() => { setIsEditingProfile(true); setAvatarInput(myInfo.avatar || "🐱"); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                  </button>
                </div>
                <div className="profile-status">{myInfo.status} (вы)</div>
              </div>
            </div>
          ) : myInfo ? (
            <form onSubmit={handleUpdateProfile} className="edit-profile-form">
              <input
                type="text"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="Имя пользователя"
                maxLength={20}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", margin: "6px 0" }}>
                <span style={{ fontSize: "11px", color: "var(--text-muted)", alignSelf: "flex-start" }}>Выберите аватар:</span>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-start", backgroundColor: "rgba(0,0,0,0.15)", padding: "6px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                  {PRESET_AVATARS.map((av) => (
                    <button
                      key={av}
                      type="button"
                      onClick={() => setAvatarInput(av)}
                      style={{
                        fontSize: "18px",
                        background: avatarInput === av ? "var(--accent)" : "none",
                        border: "none",
                        borderRadius: "6px",
                        padding: "4px",
                        cursor: "pointer",
                        width: "30px",
                        height: "30px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        transition: "all 0.15s"
                      }}
                    >
                      {av}
                    </button>
                  ))}
                </div>
              </div>
              <select value={statusInput} onChange={(e) => setStatusInput(e.target.value)}>
                <option value="online">В сети</option>
                <option value="away">Отошел</option>
                <option value="dnd">Не беспокоить</option>
                <option value="offline">Невидимый</option>
              </select>
              <div className="form-actions">
                <button type="submit" className="save-btn">Сохранить</button>
                <button type="button" className="cancel-btn" onClick={() => setIsEditingProfile(false)}>Отмена</button>
              </div>
            </form>
          ) : (
            <div style={{ fontSize: "14px", color: "var(--text-muted)" }}>Загрузка профиля...</div>
          )}
        </div>

        {/* Channels / Broadcast */}
        <div className="sidebar-section">Каналы</div>
        <div
          className={`list-item ${activeTab === "#general" ? "active" : ""}`}
          onClick={() => setActiveTab("#general")}
        >
          <div className="item-avatar">#</div>
          <div className="item-info">
            <div className="item-name">общий-чат</div>
            <div className="item-subtext">Вещание на всю сеть</div>
          </div>
        </div>

        {/* Groups */}
        <div className="sidebar-section-header">
          <div className="sidebar-section">Группы ({groups.length})</div>
          <button className="add-group-btn" onClick={() => setCreateGroupOpen(true)} title="Создать группу">
            +
          </button>
        </div>
        <div className="list-scrollable" style={{ maxHeight: "180px", flexGrow: 0, borderBottom: "1px solid var(--border-color)" }}>
          {groups.length === 0 ? (
            <div style={{ padding: "8px 20px", fontSize: "12px", color: "var(--text-muted)", fontStyle: "italic" }}>
              Группы не созданы
            </div>
          ) : (
            groups.map((group) => {
              const isLocked = group.passwordHash && !group.unlocked;
              return (
                <div
                  key={group.id}
                  className={`list-item ${activeTab === group.id ? "active" : ""}`}
                  onClick={() => handleGroupClick(group)}
                >
                  <div className="item-avatar" style={{ background: "rgba(139, 92, 246, 0.2)", border: "1px solid var(--accent)" }}>
                    {isLocked ? "🔒" : "👥"}
                  </div>
                  <div className="item-info">
                    <div className="item-name" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      {group.name}
                      {group.passwordHash && <span style={{ fontSize: "10px", opacity: 0.6 }}>🔑</span>}
                    </div>
                    <div className="item-subtext">
                      {isLocked ? "Защищено паролем" : "Локальная группа"}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Users list */}
        <div className="sidebar-section" style={{ marginTop: "8px" }}>В сети ({peers.filter(p => p.status !== "offline").length})</div>
        <div className="list-scrollable">
          {peers.length === 0 ? (
            <div style={{ padding: "16px 20px", fontSize: "13px", color: "var(--text-muted)" }}>
              Никого нет в сети
            </div>
          ) : (
            peers.map((peer) => (
              <div
                key={peer.id}
                className={`list-item ${activeTab === peer.id ? "active" : ""}`}
                onClick={() => setActiveTab(peer.id)}
              >
                <div className="item-avatar" style={{ fontSize: "20px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {peer.avatar || "🐱"}
                  <span className={`presence-dot presence-${peer.status}`} />
                </div>
                <div className="item-info">
                  <div className="item-name">{peer.username}</div>
                  <div className="item-subtext">{peer.ip}</div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* About App Button */}
        <div className="sidebar-about-container">
          <button 
            type="button" 
            className="sidebar-about-btn" 
            onClick={() => setAboutOpen(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: "6px" }}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            О приложении
          </button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="chat-area">
        {/* Header */}
        <div className="chat-header">
          <div className="header-title-wrapper">
            <div className="header-title">
              {activeTab === "#general" 
                ? "# общий-чат" 
                : activeTab.startsWith("group-")
                ? `👥 ${activeGroup?.name || "Групповой чат"}`
                : `💬 ${activePeer?.username || "Личный чат"}`}
            </div>
            <div className="header-subtitle">
              {activeTab === "#general"
                ? "Вещание на всех пользователей локальной сети"
                : activeTab.startsWith("group-")
                ? "Сообщения видны только участникам этой группы"
                : `Личная переписка • IP: ${activePeer?.ip || "Неизвестно"}`}
            </div>
          </div>
          <button className="bulletin-btn" onClick={() => setBulletinOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>
            Создать объявление
          </button>
        </div>

        {/* Messages Stream */}
        <div className="messages-list">
          {currentMessages.length === 0 ? (
            <div className="empty-chat">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span>Сообщений пока нет. Напишите первым!</span>
            </div>
          ) : (
            currentMessages.map((msg) => {
              const isMine = myInfo && msg.sender_id === myInfo.id;
              
              if (msg.isSystem) {
                return (
                  <div key={msg.id} className="system-message" style={{ alignSelf: "center", margin: "8px 0", fontSize: "12px", color: "var(--text-muted)", backgroundColor: "rgba(255,255,255,0.03)", padding: "4px 12px", borderRadius: "12px", border: "1px solid var(--border-color)" }}>
                    ⚙️ {msg.content} ({formatTime(msg.timestamp)})
                  </div>
                );
              }

              if (msg.isBulletin) {
                const expiresText = msg.expiresAt 
                  ? ` (Истекает в ${new Date(msg.expiresAt * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})})` 
                  : " (Бессрочно)";
                return (
                  <div key={msg.id} className="message-group bulletin" style={{ maxWidth: "100%", alignSelf: "center", width: "90%" }}>
                    <div className="message-content-wrapper" style={{ width: "100%" }}>
                      <div className="message-sender">📢 ВАЖНОЕ ОБЪЯВЛЕНИЕ от {msg.sender_name}{expiresText}</div>
                      <div className="message-bubble">
                        {msg.content}
                      </div>
                      <div className="message-time">{formatTime(msg.timestamp)}</div>
                    </div>
                  </div>
                );
              }

              // Poll Rendering
              if (msg.isPoll && msg.pollData) {
                const poll = msg.pollData;
                const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes.length, 0);
                const hasVoted = poll.options.some((opt) => myInfo && opt.votes.includes(myInfo.id));

                return (
                  <div key={msg.id} className="message-group" style={{ alignSelf: "center", width: "85%", maxWidth: "500px" }}>
                    <div className="message-content-wrapper" style={{ width: "100%" }}>
                      <div className="message-sender">📊 ГОЛОСОВАНИЕ от {msg.sender_name}</div>
                      <div className="poll-card" style={{
                        backgroundColor: "var(--bg-sidebar)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "12px",
                        padding: "16px",
                        width: "100%",
                        boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.3)"
                      }}>
                        <h4 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "14px", color: "var(--text-main)" }}>{poll.question}</h4>
                        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                          {poll.options.map((opt) => {
                            const optionVotesCount = opt.votes.length;
                            const percentage = totalVotes > 0 ? Math.round((optionVotesCount / totalVotes) * 100) : 0;
                            const isMyVote = myInfo && opt.votes.includes(myInfo.id);

                            return (
                              <div
                                key={opt.id}
                                onClick={() => handleVote(poll.id, opt.id)}
                                className={`poll-option-row ${isMyVote ? "voted" : ""} ${hasVoted ? "disabled" : ""}`}
                                style={{
                                  position: "relative",
                                  padding: "12px 16px",
                                  borderRadius: "8px",
                                  backgroundColor: "rgba(255, 255, 255, 0.02)",
                                  border: isMyVote ? "1.5px solid var(--accent)" : "1px solid var(--border-color)",
                                  cursor: "pointer",
                                  overflow: "hidden",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  fontSize: "14px",
                                  transition: "all 0.2s"
                                }}
                              >
                                {/* Fill background bar */}
                                <div
                                  className="poll-option-fill"
                                  style={{
                                    position: "absolute",
                                    left: 0,
                                    top: 0,
                                    bottom: 0,
                                    width: `${percentage}%`,
                                    backgroundColor: isMyVote ? "rgba(139, 92, 246, 0.15)" : "rgba(255,255,255,0.03)",
                                    transition: "width 0.4s cubic-bezier(0.1, 0.8, 0.25, 1)",
                                    zIndex: 0
                                  }}
                                />
                                <span style={{ zIndex: 1, fontWeight: isMyVote ? 600 : 400 }}>
                                  {isMyVote && <span style={{ marginRight: "6px" }}>✓</span>}
                                  {opt.text}
                                </span>
                                <span style={{ zIndex: 1, color: "var(--text-muted)", fontSize: "13px" }}>
                                  {percentage}% ({optionVotesCount})
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{ marginTop: "12px", fontSize: "11px", color: "var(--text-muted)", display: "flex", justifyContent: "space-between" }}>
                          <span>Всего голосов: {totalVotes}</span>
                          {hasVoted && <span style={{ color: "var(--accent-hover)" }}>Вы проголосовали</span>}
                        </div>
                      </div>
                      <div className="message-time">{formatTime(msg.timestamp)}</div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={msg.id} className={`message-group ${isMine ? "mine" : ""}`}>
                  <div className="message-content-wrapper">
                    {!isMine && (
                      <div className="message-sender" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontSize: "14px" }}>{peers.find(p => p.id === msg.sender_id)?.avatar || "🐱"}</span>
                        {msg.sender_name}
                      </div>
                    )}
                    <div className="message-bubble">
                      {msg.content}
                      
                      {/* Attached File/Image Rendering */}
                      {msg.file_data && (
                        <div className="message-attachment" style={{ marginTop: "8px" }}>
                          {msg.file_data.is_image ? (
                            <img 
                              src={msg.file_data.base64_data} 
                              alt={msg.file_data.name} 
                              style={{ 
                                maxWidth: "100%", 
                                maxHeight: "200px", 
                                borderRadius: "8px", 
                                border: "1px solid var(--border-color)",
                                cursor: "pointer",
                                display: "block",
                                marginTop: "4px"
                              }}
                              onClick={() => setPreviewImage({ url: msg.file_data!.base64_data, name: msg.file_data!.name })}
                              title="Нажмите, чтобы увеличить изображение"
                            />
                          ) : (
                            <div 
                              className="file-card"
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                                padding: "8px 12px",
                                backgroundColor: "rgba(0,0,0,0.15)",
                                border: "1px solid var(--border-color)",
                                borderRadius: "6px",
                                marginTop: "6px",
                                maxWidth: "260px"
                              }}
                            >
                              <span style={{ fontSize: "20px" }}>📄</span>
                              <div style={{ flexGrow: 1, minWidth: 0 }}>
                                <div style={{ fontSize: "12px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={msg.file_data.name}>
                                  {msg.file_data.name}
                                </div>
                                <div style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "2px" }}>
                                  {(msg.file_data.size / 1024).toFixed(1)} КБ
                                </div>
                              </div>
                              <button 
                                type="button"
                                onClick={() => downloadBase64File(msg.file_data!)}
                                style={{
                                  background: "var(--accent-soft)",
                                  border: "1px solid rgba(139, 92, 246, 0.3)",
                                  color: "var(--accent-hover)",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  borderRadius: "4px",
                                  fontSize: "12px"
                                }}
                                title="Скачать файл"
                              >
                                💾
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="message-time">{formatTime(msg.timestamp)}</div>
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <div className="chat-composer">
          <form onSubmit={handleSendMessage} className="composer-form" style={{ position: "relative" }}>
            {/* Emoji Trigger */}
            <button 
              type="button" 
              className="emoji-trigger-btn"
              onClick={() => setEmojiPickerOpen(!emojiPickerOpen)}
              title="Добавить смайл"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 8px", outline: "none", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
                <line x1="9" y1="9" x2="9.01" y2="9"/>
                <line x1="15" y1="9" x2="15.01" y2="9"/>
              </svg>
            </button>

            {/* File Attachment Trigger */}
            <button 
              type="button" 
              className="emoji-trigger-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Прикрепить файл или фото"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 8px", outline: "none", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
              </svg>
            </button>

            {/* Create Poll Trigger */}
            <button 
              type="button" 
              className="emoji-trigger-btn"
              onClick={() => setCreatePollOpen(true)}
              title="Создать голосование"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 8px", outline: "none", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
            </button>

            <input 
              type="file" 
              ref={fileInputRef}
              onChange={handleFileChange}
              style={{ display: "none" }}
            />

            {/* Emoji Picker Popup */}
            {emojiPickerOpen && (
              <div 
                ref={emojiPickerRef} 
                className="emoji-picker-popup"
                style={{
                  position: "absolute",
                  bottom: "55px",
                  left: "10px",
                  backgroundColor: "var(--bg-sidebar)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  padding: "10px",
                  display: "grid",
                  gridTemplateColumns: "repeat(5, 1fr)",
                  gap: "8px",
                  zIndex: 50,
                  boxShadow: "0 10px 15px -3px rgba(0,0,0,0.5)"
                }}
              >
                {POPULAR_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => handleEmojiClick(emoji)}
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "20px",
                      cursor: "pointer",
                      padding: "4px",
                      borderRadius: "4px",
                      transition: "background 0.2s"
                    }}
                    className="emoji-btn"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                activeTab === "#general"
                  ? "Написать сообщение в общий чат локальной сети..."
                  : activeTab.startsWith("group-")
                  ? `Написать сообщение в группу ${activeGroup?.name || ""}...`
                  : `Написать личное сообщение ${activePeer?.username || ""}...`
              }
              className="composer-input"
            />
            <button type="submit" className="send-btn">
              <span>Отправить</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </form>
        </div>
      </div>

      {/* Bulletin Board Modal */}
      {bulletinOpen && (
        <div className="bulletin-overlay" onClick={() => setBulletinOpen(false)}>
          <div className="bulletin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Создать объявление</h3>
              <button className="close-btn" onClick={() => setBulletinOpen(false)}>&times;</button>
            </div>
            <form onSubmit={handlePostBulletin}>
              <div className="modal-body">
                <div className="bulletin-form-group">
                  <label>Текст объявления</label>
                  <textarea
                    value={bulletinText}
                    onChange={(e) => setBulletinText(e.target.value)}
                    placeholder="Напишите важное объявление, которое увидят все участники локальной сети..."
                    required
                    maxLength={300}
                  />
                </div>
                
                {/* Expiration Selector */}
                <div className="bulletin-form-group" style={{ marginTop: "12px" }}>
                  <label>Срок действия объявления</label>
                  <select 
                    value={bulletinDuration} 
                    onChange={(e) => setBulletinDuration(parseInt(e.target.value))}
                    style={{
                      width: "100%",
                      backgroundColor: "var(--bg-input)",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      padding: "12px",
                      color: "white",
                      fontSize: "14px",
                      outline: "none",
                      cursor: "pointer"
                    }}
                  >
                    <option value={0}>Бессрочно</option>
                    <option value={60}>1 минута (для теста)</option>
                    <option value={3600}>1 час</option>
                    <option value={43200}>12 часов</option>
                    <option value={86400}>1 день</option>
                    <option value={604800}>1 неделя</option>
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="cancel-btn" onClick={() => setBulletinOpen(false)}>Отмена</button>
                <button type="submit" className="post-btn">Опубликовать</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Group Modal */}
      {createGroupOpen && (
        <div className="bulletin-overlay" onClick={() => setCreateGroupOpen(false)}>
          <div className="bulletin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Создать локальную группу</h3>
              <button className="close-btn" onClick={() => setCreateGroupOpen(false)}>&times;</button>
            </div>
            <form onSubmit={handleCreateGroup}>
              <div className="modal-body">
                <div className="bulletin-form-group">
                  <label>Название группы</label>
                  <input
                    type="text"
                    value={groupNameInput}
                    onChange={(e) => setGroupNameInput(e.target.value)}
                    placeholder="Например: Отдел разработки, Обед..."
                    required
                    maxLength={25}
                    style={{
                      width: "100%",
                      backgroundColor: "var(--bg-input)",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      padding: "12px",
                      color: "white",
                      fontSize: "14px",
                      outline: "none"
                    }}
                  />
                </div>
                
                {/* Password Protection */}
                <div className="bulletin-form-group" style={{ flexDirection: "row", alignItems: "center", gap: "8px", marginTop: "8px" }}>
                  <input
                    type="checkbox"
                    id="protect-checkbox"
                    checked={isPasswordProtected}
                    onChange={(e) => setIsPasswordProtected(e.target.checked)}
                    style={{ cursor: "pointer", width: "16px", height: "16px" }}
                  />
                  <label htmlFor="protect-checkbox" style={{ cursor: "pointer", fontSize: "14px", color: "var(--text-main)", userSelect: "none" }}>
                    Защитить группу паролем
                  </label>
                </div>

                {isPasswordProtected && (
                  <div className="bulletin-form-group" style={{ marginTop: "4px" }}>
                    <label>Пароль для входа в группу</label>
                    <input
                      type="password"
                      value={groupPasswordInput}
                      onChange={(e) => setGroupPasswordInput(e.target.value)}
                      placeholder="Введите пароль..."
                      required={isPasswordProtected}
                      maxLength={32}
                      style={{
                        width: "100%",
                        backgroundColor: "var(--bg-input)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "8px",
                        padding: "12px",
                        color: "white",
                        fontSize: "14px",
                        outline: "none"
                      }}
                    />
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="cancel-btn" onClick={() => setCreateGroupOpen(false)}>Отмена</button>
                <button type="submit" className="post-btn">Создать</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Poll Modal */}
      {createPollOpen && (
        <div className="bulletin-overlay" onClick={() => setCreatePollOpen(false)}>
          <div className="bulletin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Создать голосование</h3>
              <button className="close-btn" onClick={() => setCreatePollOpen(false)}>&times;</button>
            </div>
            <form onSubmit={handleCreatePoll}>
              <div className="modal-body" style={{ maxHeight: "380px", overflowY: "auto" }}>
                <div className="bulletin-form-group">
                  <label>Вопрос голосования</label>
                  <input
                    type="text"
                    value={pollQuestionInput}
                    onChange={(e) => setPollQuestionInput(e.target.value)}
                    placeholder="Например: Куда пойдем обедать?"
                    required
                    maxLength={100}
                    style={{
                      width: "100%",
                      backgroundColor: "var(--bg-input)",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      padding: "12px",
                      color: "white",
                      fontSize: "14px",
                      outline: "none"
                    }}
                  />
                </div>

                <div className="bulletin-form-group" style={{ marginTop: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <label>Варианты ответов</label>
                    <button
                      type="button"
                      onClick={addPollOptionField}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--accent-hover)",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: "pointer"
                      }}
                    >
                      + Добавить вариант
                    </button>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "6px" }}>
                    {pollOptionsList.map((option, idx) => (
                      <div key={idx} style={{ display: "flex", gap: "8px" }}>
                        <input
                          type="text"
                          value={option}
                          onChange={(e) => updatePollOptionValue(idx, e.target.value)}
                          placeholder={`Вариант ${idx + 1}`}
                          required={idx < 2}
                          maxLength={40}
                          style={{
                            flexGrow: 1,
                            backgroundColor: "var(--bg-input)",
                            border: "1px solid var(--border-color)",
                            borderRadius: "8px",
                            padding: "10px 12px",
                            color: "white",
                            fontSize: "13px",
                            outline: "none"
                          }}
                        />
                        {pollOptionsList.length > 2 && (
                          <button
                            type="button"
                            onClick={() => removePollOptionField(idx)}
                            style={{
                              background: "rgba(244, 63, 94, 0.15)",
                              border: "1px solid rgba(244, 63, 94, 0.3)",
                              color: "var(--status-dnd)",
                              cursor: "pointer",
                              padding: "0 12px",
                              borderRadius: "8px",
                              fontSize: "14px"
                            }}
                          >
                            &times;
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="cancel-btn" onClick={() => setCreatePollOpen(false)}>Отмена</button>
                <button type="submit" className="post-btn">Опубликовать</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Enter Password Challenge Modal */}
      {passwordPromptOpen && targetGroupToUnlock && (
        <div className="bulletin-overlay" onClick={() => setPasswordPromptOpen(false)}>
          <div className="bulletin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Требуется пароль</h3>
              <button className="close-btn" onClick={() => setPasswordPromptOpen(false)}>&times;</button>
            </div>
            <form onSubmit={handleUnlockGroup}>
              <div className="modal-body">
                <div className="bulletin-form-group">
                  <label>Введите пароль для входа в группу "{targetGroupToUnlock.name}"</label>
                  <input
                    type="password"
                    value={passwordPromptText}
                    onChange={(e) => setPasswordPromptText(e.target.value)}
                    placeholder="Пароль..."
                    required
                    autoFocus
                    style={{
                      width: "100%",
                      backgroundColor: "var(--bg-input)",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      padding: "12px",
                      color: "white",
                      fontSize: "14px",
                      outline: "none"
                    }}
                  />
                  {passwordPromptError && (
                    <div style={{ color: "var(--status-dnd)", fontSize: "12px", marginTop: "4px" }}>
                      ⚠️ {passwordPromptError}
                    </div>
                  )}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="cancel-btn" onClick={() => setPasswordPromptOpen(false)}>Отмена</button>
                <button type="submit" className="post-btn">Войти</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Image Preview / Lightbox Modal */}
      {previewImage && (
        <div className="image-preview-overlay" onClick={() => setPreviewImage(null)}>
          <div className="image-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="preview-modal-header">
              <span className="preview-filename">{previewImage.name}</span>
              <div className="preview-actions">
                <button className="preview-action-btn" onClick={() => {
                  const link = document.createElement("a");
                  link.href = previewImage.url;
                  link.download = previewImage.name;
                  link.click();
                }} title="Скачать">
                  💾 Скачать
                </button>
                <button className="preview-action-btn close" onClick={() => setPreviewImage(null)} title="Закрыть">
                  &times;
                </button>
              </div>
            </div>
            <div className="preview-image-container">
              <img src={previewImage.url} alt={previewImage.name} className="preview-main-img" />
            </div>
          </div>
        </div>
      )}

      {/* About App Modal */}
      {aboutOpen && (
        <div className="bulletin-overlay" onClick={() => setAboutOpen(false)}>
          <div className="bulletin-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "370px" }}>
            <div className="modal-header">
              <h3>О приложении</h3>
              <button className="close-btn" onClick={() => setAboutOpen(false)}>&times;</button>
            </div>
            <div className="modal-body" style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", padding: "24px 20px" }}>
              <div style={{ fontSize: "44px", animation: "pulse 2s infinite" }}>🌙</div>
              <div>
                <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-main)" }}>LunaChat</h2>
                <div style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "6px" }}>Версия: 1.0.4</div>
                <div style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "4px" }}>Разработчик: Osipov Eduard</div>
              </div>
              <button 
                type="button" 
                className="post-btn" 
                style={{ 
                  marginTop: "8px", 
                  width: "100%", 
                  padding: "12px", 
                  borderRadius: "8px", 
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  fontSize: "14px",
                  background: "linear-gradient(135deg, var(--accent) 0%, #3b82f6 100%)",
                  border: "none",
                  cursor: "pointer",
                  color: "white",
                  boxShadow: "0 4px 12px rgba(139, 92, 246, 0.3)"
                }}
                onClick={async () => {
                  try {
                    await openUrl("https://send.monobank.ua/jar/mHTsyv3bB");
                  } catch (err) {
                    console.error("Failed to open link", err);
                  }
                }}
              >
                💛 Помочь проекту
              </button>

              {/* Раздел авто-обновлений */}
              <div style={{ width: "100%", borderTop: "1px solid var(--border-color)", paddingTop: "14px", marginTop: "4px", display: "flex", flexDirection: "column", gap: "8px" }}>
                {updateStatus && (
                  <div style={{ fontSize: "13px", color: "var(--text-main)", marginBottom: "4px" }}>
                    {updateStatus}
                  </div>
                )}
                {hasUpdate ? (
                  <button
                    type="button"
                    className="post-btn"
                    disabled={checkingUpdates}
                    onClick={handleInstallUpdate}
                    style={{
                      width: "100%",
                      padding: "10px",
                      borderRadius: "8px",
                      fontWeight: 600,
                      fontSize: "13px",
                      backgroundColor: "var(--accent)",
                      border: "none",
                      cursor: checkingUpdates ? "not-allowed" : "pointer",
                      color: "white"
                    }}
                  >
                    {checkingUpdates ? "Установка..." : "Установить и перезапустить"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cancel-btn"
                    disabled={checkingUpdates}
                    onClick={handleCheckForUpdates}
                    style={{
                      width: "100%",
                      padding: "10px",
                      borderRadius: "8px",
                      fontWeight: 600,
                      fontSize: "13px",
                      border: "1px solid var(--border-color)",
                      cursor: checkingUpdates ? "not-allowed" : "pointer",
                      backgroundColor: "rgba(255, 255, 255, 0.05)",
                      color: "white"
                    }}
                  >
                    {checkingUpdates ? "Проверка..." : "Проверить обновления"}
                  </button>
                )}
              </div>
            </div>
            <div className="modal-footer" style={{ justifyContent: "center", padding: "12px 20px" }}>
              <button type="button" className="cancel-btn" onClick={() => { setAboutOpen(false); setUpdateStatus(null); setHasUpdate(false); }} style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "none", cursor: "pointer", fontWeight: 500 }}>Закрыть</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
