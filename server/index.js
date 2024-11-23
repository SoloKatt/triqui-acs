import express from 'express'
import logger from 'morgan'
import dotenv from 'dotenv'
import { createClient } from '@libsql/client'
import { Server} from 'socket.io'
import { createServer } from 'node:http'

dotenv.config()
const port = process.env.PORT ?? 3000

const app = express()
const server = createServer(app)
const io = new Server(server, {
    connectionStateRecovery:{}
})
// Conexion con la base de datos
const db = createClient({
    url: "libsql://triqui-acs-solokatt.turso.io",
    authToken: process.env.DB_TOKEN,
})

// Crea la tabla de usuarios si esta no existe
await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE
        )
    `)

// Crear la tabla de jugadas del juego
await db.execute(`
    CREATE TABLE IF NOT EXISTS game_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player TEXT,
        position INTEGER
    )
`)

app.use(express.json())
app.use(logger('dev'))

// Ruta para registrar un nuevo usuario
app.post('/register', async (req, res) => {
    const { username } = req.body
    if (!username) {
        return res.status(400).json({ message: 'El nombre de usuario es requerido.' })
    }

    try {
        // Comprobar si el nombre de usuario ya existe
        const checkUser = await db.execute({
            sql: 'SELECT * FROM users WHERE username = :username',
            args: { username }
        })

        if (checkUser.rows.length > 0) {
            // Si ya existe el usuario, devolver un error
            console.log('El usuario ya existe');
            return res.status(400).json({ message: 'El nombre de usuario ya está en uso.' })
        }

        // Insertar el nuevo usuario si no existe
        const result = await db.execute({
            sql: 'INSERT INTO users (username) VALUES (:username)',
            args: { username }
        })

        console.log('Usuario registrado con éxito');
        
        // Convertir BigInt a String o Number antes de enviarlo
        const userId = result.lastInsertRowid.toString();  // Usamos toString() para convertir BigInt a String

        // Si todo sale bien, devolver el mensaje de éxito
        res.status(201).json({ message: 'Usuario registrado correctamente', userId: userId })
    } catch (e) {
        console.error('Error al registrar el usuario: ', e);
        res.status(500).json({ message: 'Error al registrar el usuario.' })
    }
})

// Ruta para iniciar sesión
app.post('/login', async (req, res) => {
    const { username } = req.body
    if (!username) {
        return res.status(400).json({ message: 'El nombre de usuario es requerido.' })
    }
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM users WHERE username = :username',
            args: { username }
        })
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' })
        }
        res.status(200).json({ message: 'Login exitoso', username })
    } catch (e) {
        console.error(e)
        res.status(500).json({ message: 'Error al iniciar sesión.' })
    }
})

let connectedusers = 0;
const MAX_USERS = 2;

io.on('connection', async (socket) => {

    // Aquí el jugador se autentica con su nombre de usuario cuando se conecta
    socket.on('login', (username) => {
        socket.handshake.auth.username = username
        console.log(`Usuario conectado: ${username}`)
    });

    // Verificar el número de conexiones actuales
    if (connectedusers >= MAX_USERS) {
        socket.emit('error', 'El servidor está lleno. Intenta más tarde.');
        socket.disconnect();  // Desconectar al usuario si el límite ha sido alcanzado
        console.log('Conexión rechazada: límite de usuarios alcanzado');
        return;
    }

    // Incrementar el contador de usuarios conectados
    connectedusers++;
    console.log(`Usuarios conectados: ${connectedusers}`);

    socket.on('disconnect', () => {
        connectedusers--;  // Decrementar el contador al desconectarse un usuario
        console.log(`Un usuario se ha desconectado. Usuarios conectados: ${connectedusers}`);
    });

    socket.on('make move', async (move) => {
        let result
        const player = socket.handshake.auth.username ?? 'anonymous'
        try {
            result = await db.execute({
                sql: 'INSERT INTO game_moves (player, position) VALUES (:player, :position)',
                args: { player, position: move.position }
            })
        } catch (e) {
            console.error(e)
            return
        }
        io.emit('game update', move, result.lastInsertRowid.toString(), player)
    })
})

app.get('/full', (req, res) => {
    res.send('<h1>El servidor está lleno. Intenta más tarde.</h1>');
});

app.get('/', (req, res) => {
    res.sendFile(process.cwd() + '/client/index.html')
})

server.listen(port, () => {
    console.log(`Server running on port ${port}`)
})
