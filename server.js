// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0'; // Важно: слушаем все интерфейсы

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Сессии для авторизации
app.use(session({
    secret: 'your-secret-key-here',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // true для HTTPS
}));

// База данных SQLite
const db = new sqlite3.Database('./database.sqlite');

// Создаем таблицы
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        role TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
});

// API ключ для GPT
const API_KEY = "sk-CnSOtbWN7v2mmaEvr1JzM96XOIJnIsYZkJBkH9jKOJVvYwXTCLeX83wxWTeQ";
const GPT_URL = "https://api.gen-api.ru/api/v1/networks/chat-gpt-3";

// Системное сообщение для GPT
const systemMessage = {
    role: "system",
    content: `Ты креативный помощник с расширенными возможностями форматирования.

ВАЖНЫЕ ПРАВИЛА ФОРМАТИРОВАНИЯ:
1. Используй **жирный текст** для важных моментов
2. Используй *курсив* для акцентов
3. Для списков используй - или 1.
4. Для таблиц используй:
   | Заголовок 1 | Заголовок 2 |
   |------------|------------|
   | ячейка 1   | ячейка 2   |
   
   ВАЖНО: В таблицах для нижних индексов используй $x_1$ или $x_{123}$
   Для степеней используй $x^2$ или $x^{123}$
   Для дробей используй $\\frac{1}{2}$
   
5. Для математических формул используй $$формула$$ (например, $$\\frac{1}{2}$$ для дроби 1/2)
6. Для кода используй \`\`\`язык
   код
   \`\`\`
7. Для цитат используй > текст

Будь дружелюбным, креативным и используй всё разнообразие форматирования для лучшей передачи информации.`
};

// История сообщений для пользователя (в памяти)
const userHistories = new Map();

// ============ АВТОРИЗАЦИЯ ============

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run('INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Username already exists' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }

                req.session.userId = this.lastID;
                req.session.username = username;

                res.json({
                    success: true,
                    username,
                    message: 'Registration successful'
                });
            });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Логин
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        req.session.userId = user.id;
        req.session.username = user.username;

        res.json({
            success: true,
            username: user.username,
            message: 'Login successful'
        });
    });
});

// Проверка авторизации
app.get('/api/check-auth', (req, res) => {
    if (req.session.userId) {
        res.json({
            authenticated: true,
            username: req.session.username
        });
    } else {
        res.json({ authenticated: false });
    }
});

// Выход
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ============ GPT ЧАТ ============

app.post('/api/chat', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { message } = req.body;
    const userId = req.session.userId;

    try {
        // Получаем или создаем историю для пользователя
        if (!userHistories.has(userId)) {
            const history = await new Promise((resolve, reject) => {
                db.all(
                    'SELECT role, content FROM chat_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20',
                    [userId],
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows.reverse());
                    }
                );
            });

            userHistories.set(userId, history);
        }

        let messages = userHistories.get(userId);

        // Добавляем системное сообщение, если его нет
        if (messages.length === 0 || messages[0].role !== 'system') {
            messages.unshift(systemMessage);
        }

        // Добавляем сообщение пользователя
        messages.push({ role: "user", content: message });

        // Сохраняем в БД
        db.run('INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)',
            [userId, 'user', message]);

        // Отправляем запрос к API
        const response = await axios.post(GPT_URL, {
            messages: messages,
            is_sync: true,
            temperature: 0.9,
            max_tokens: 2000
        }, {
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": `Bearer ${API_KEY}`
            }
        });

        let answer;
        try {
            answer = response.data.response[0].message.content;
        } catch (e) {
            answer = "Извините, произошла ошибка. Попробуйте еще раз.";
        }

        // Добавляем ответ ассистента
        messages.push({ role: "assistant", content: answer });

        // Сохраняем в БД
        db.run('INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)',
            [userId, 'assistant', answer]);

        // Ограничиваем историю до 50 сообщений
        if (messages.length > 50) {
            messages = [systemMessage, ...messages.slice(-49)];
        }

        userHistories.set(userId, messages);

        res.json({
            response: answer,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('GPT Error:', error);
        res.status(500).json({
            error: 'Failed to get response from GPT',
            details: error.message
        });
    }
});

// Получить историю чата
app.get('/api/history', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    db.all(
        'SELECT role, content, timestamp FROM chat_history WHERE user_id = ? ORDER BY timestamp ASC',
        [req.session.userId],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(rows);
        }
    );
});

// Очистить историю
app.post('/api/clear-history', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    db.run('DELETE FROM chat_history WHERE user_id = ?', [req.session.userId], (err) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        userHistories.delete(req.session.userId);
        res.json({ success: true });
    });
});

// Запускаем сервер на всех интерфейсах
app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}/`);
    console.log(`Local access: http://localhost:${PORT}/`);
    console.log(`Network access: http://YOUR_IP:${PORT}/`);
    console.log(`Forward this port to your domain via SSH tunnel`);
});