import express from 'express'
import logger from 'morgan'
import dotenv from 'dotenv'
import { createClient } from '@libsql/client'
import { Server } from 'socket.io'
import { createServer } from 'node:http'

dotenv.config()
const port = process.env.PORT ?? 3000

const app = express()
const server = createServer(app)
const io = new Server(server, {
    connectionStateRecovery: {}
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
    
app.use(logger('dev'))
app.use(express.json())
// Para que funcione el css del cliente
app.use(express.static('client'))

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
const gamingusers = new Map();
let waitingPlayer = null;
let players = []
let games = {}; // Variable global para almacenar las partidas

function assignRoles() {
    // Asignar aleatoriamente el orden
    const firstPlayerIndex = Math.floor(Math.random() * players.length);
    const secondPlayerIndex = 1 - firstPlayerIndex;

    // Asignar aleatoriamente las fichas
    const roles = ['X', 'O'];
    const shuffledRoles = roles.sort(() => Math.random() - 0.5);

    players[firstPlayerIndex].role = shuffledRoles[0];
    players[secondPlayerIndex].role = shuffledRoles[1];

    // Notificar a los jugadores sus roles
    players.forEach((player, index) => {
        const opponentUsername = players[index === firstPlayerIndex ? secondPlayerIndex : firstPlayerIndex].username;
        io.to(player.id).emit('role assigned', {
            role: player.role,
            order: index === firstPlayerIndex ? 'first' : 'second',
            opponentUsername // Aquí pasamos el nombre del oponente
        });
    });

    console.log(
        `Roles asignados: ${players[firstPlayerIndex].username} es ${shuffledRoles[0]} y comienza. ` +
        `${players[secondPlayerIndex].username} es ${shuffledRoles[1]} y va segundo.`
    );
}

io.on('connection', async (socket) => {

    // Aquí el jugador se autentica con su nombre de usuario cuando se conecta
    socket.on('login', (username) => {
        // Verificar si el usuario ya está conectado
        if (Array.from(gamingusers.values()).includes(username)) {
            socket.emit('error', { type: 'duplicate_user', message: 'Este usuario ya está conectado.' });
            console.log(`Intento de conexión rechazado para el usuario: ${username}`);
            return;
        }
        socket.handshake.auth.username = username;
        gamingusers.set(socket.id, username);
        connectedusers++;
        console.log(`Usuario conectado: ${username}`);
        console.log(`Usuarios conectados: ${connectedusers}`);

        players.push({ id: socket.id, username });

        // Manejamos la sala de espera
        if (waitingPlayer === null) {
            waitingPlayer = socket;
            socket.emit('waiting', { message: 'Esperando a otro jugador...' });
            console.log(`Jugador ${username} está esperando oponente.`);
        } else {
            const opponent = waitingPlayer;
            const opponentUsername = gamingusers.get(opponent.id);
            waitingPlayer = null; // Vaciar la sala de espera
            const room = `game-${socket.id}-${opponent.id}`;
            socket.join(room);
            opponent.join(room);
            io.to(room).emit('start game', { message: 'Ambos jugadores conectados. ¡Comienza el juego!' });
            console.log(`Sala creada: ${room} entre ${username} y ${opponentUsername}`);

            // Ahora asignamos los roles
            assignRoles();  // Llamamos a la función que asigna roles
        }
    });

    

    // Verificar el número de conexiones actuales
    if (connectedusers >= MAX_USERS) {
        socket.emit('error', { type: 'server_full', message: 'El servidor está lleno. Intenta más tarde.' });
        console.log('Conexión rechazada: límite de usuarios alcanzado');
        return;
    }

    socket.on('disconnect', () => {
        const disconnectedUser = gamingusers.get(socket.id);
        if (disconnectedUser) {
            console.log(`El usuario: ${disconnectedUser} se ha desconectado`);
            gamingusers.delete(socket.id);
            connectedusers--;
            console.log(`Un usuario se ha desconectado. Usuarios conectados: ${connectedusers}`);

            // Eliminar al jugador de la lista de players
            players = players.filter(player => player.id !== socket.id);
        }
        if (waitingPlayer === socket) {
            waitingPlayer = null;
            console.log('Jugador en espera desconectado.');
        }
    });

    if (connectedusers < 0) {
        connectedusers = 0;
    }

    
// Escuchar movimientos realizados por el cliente
socket.on('make move', ({ cell }) => {
    const game = games[socket.gameId]; // Obtener el estado de la partida
    if (!game) return;

    // Verificar que sea el turno del jugador correcto
    if (game.currentTurn !== socket.id) {
        socket.emit('error', { message: 'No es tu turno.' });
        return;
    }

    // Actualizar el tablero
    if (!game.board[cell]) {
        game.board[cell] = game.roles[socket.id]; // 'X' o 'O'

        // Alternar el turno
        game.currentTurn = game.players.find((player) => player !== socket.id);

        // Verificar si alguien ganó
        const winner = checkWinner(game.board);
        if (winner || game.board.every((cell) => cell)) {
            // Finalizar el juego
            io.to(game.id).emit('game over', { winner });
        } else {
            // Actualizar el tablero para ambos jugadores
            io.to(game.id).emit('update board', {
                board: game.board,
                nextTurn: game.roles[game.currentTurn],
            });
        }
    }
});





})



app.get('/duplicateuser', (req, res) => {
    res.sendFile(process.cwd() + '/client/duplicateuser.html');
});

app.get('/full', (req, res) => {
    res.sendFile(process.cwd() + '/client/full.html');
});

app.get('/', (req, res) => {
    res.sendFile(process.cwd() + '/client/index.html')
})

server.listen(port, () => {
    console.log(`Server running on port ${port}`)
})
