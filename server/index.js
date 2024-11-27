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


const combinacionesGanadoras = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Filas
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columnas
    [0, 4, 8], [2, 4, 6]            // Diagonales
];
let tablero = Array(9).fill(null); // Inicia vacío
    
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
let turnoActual;

function assignRoles(room) {
    // Verificar que la partida existe
    if (!games[room]) {
        console.error(`No se encontró la partida para la sala: ${room}`);
        return;
    }

    const game = games[room];
    const [player1, player2] = game.players;

    // Asignar roles aleatoriamente ('X' o 'O')
    let roles = ['X', 'O'].sort(() => Math.random() - 0.5);
    game.roles = {[player1]: roles[0],[player2]: roles[1]};

    // Elegir aleatoriamente quién comienza
    const startingPlayer = Math.random() < 0.5 ? player1 : player2;
    game.currentTurn = startingPlayer;
    
    // Notificar roles y turno inicial a los jugadores
    io.to(player1).emit('role assigned', {
        role: game.roles[player1],
        order: startingPlayer === player1 ? 'first' : 'second',
        opponentUsername: gamingusers.get(player2),
    });
    io.to(player2).emit('role assigned', {
        role: game.roles[player2],
        order: startingPlayer === player2 ? 'first' : 'second',
        opponentUsername: gamingusers.get(player1),
    });

    console.log(
        `Roles asignados en la sala ${room}: ${gamingusers.get(player1)} (${game.roles[player1]}) ` +
        `vs ${gamingusers.get(player2)} (${game.roles[player2]}). Empieza: ${gamingusers.get(startingPlayer)}`
    );

    if (gamingusers.get(startingPlayer) === gamingusers.get(player1)){
        if(game.roles[player1] === 'X'){
            turnoActual = 'X'
        } else { turnoActual = 'O'}
    } else {
        if(game.roles[player2] === 'X'){
            turnoActual = 'X'
        } else { turnoActual = 'O'}
    }
}

io.on('connection', async (socket) => {
    let currentGame = null;
    let playerRole = null;
    let playerOrder = null;

    // Aquí el jugador se autentica con su nombre de usuario cuando se conecta
    socket.on('login', (username) => {
        // Verificar si el usuario ya está conectado
        if (Array.from(gamingusers.values()).includes(username)) {
            socket.emit('error', { type: 'duplicate_user', message: 'Este usuario ya está conectado.' });
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
            games[room] = {
                id: room,
                board: Array(9).fill(null), // Tablero vacío
                players: [socket.id, opponent.id],
                roles: { [socket.id]: null, [opponent.id]: null }, // Se asignarán después
                currentTurn: null, // Será el jugador que empiece
            };
            io.to(room).emit('start game', { message: 'Ambos jugadores conectados. ¡Comienza el juego!' });
            console.log(`Sala creada: ${room} entre ${username} y ${opponentUsername}`);

            // Ahora asignamos los roles
            assignRoles(room);  // Llamamos a la función que asigna roles
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

            // Terminar el juego si estaba jugando
        for (const room in games) {
            const game = games[room];
            if (game.players.includes(socket.id)) {
                const opponentId = game.players.find((id) => id !== socket.id);
                io.to(opponentId).emit('game over', { winner: null, message: 'El oponente se desconectó.' });
                delete games[room];
                break;
            }
        }
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

        // Comprobar si la celda ya está ocupada
        if (game.board[cell] !== '') {
            socket.emit('error', { message: 'La celda ya está ocupada.' });
            return; // La celda ya está ocupada
        }

        // Realizar la jugada
        game.board[cell] = game.roles[socket.id]; // Asignar 'X' o 'O' al tablero

        // Alternar el turno
        game.currentTurn = game.players.find((playerId) => playerId !== socket.id);

    });
    console.log("jugada");

    socket.on('jugada', function (dataS) {
        console.log(`turno actual ---> ${turnoActual}`);
        console.log(`Estado del tablero antes de la jugada: ${JSON.stringify(tablero)}`);
    
        if (dataS.id === turnoActual) {
            tablero[dataS.id2] = dataS.id;  // Almacenar la jugada en el tablero
            // Emitimos la jugada válida a todos los clientes
            io.sockets.emit('jugada2', dataS);
            console.log(`Jugada de ${dataS.id} en el cuadro ${dataS.id2}`);
            console.log(`turno jugado ---> ${turnoActual}`);
            console.log(`Estado del tablero DESPUES de la jugada: ${JSON.stringify(tablero)}`);
            // Cambiar el turno al otro jugador
            turnoActual = turnoActual === 'X' ? 'O' : 'X'; 
    
            // Notificamos a todos cuál es el nuevo turno
            io.sockets.emit('actualizarTurno', { turno: turnoActual });
            console.log(`nuevo turno ---> ${turnoActual}`);
    
            // Verificar si hay un ganador
            if (verificarGanador(dataS.id)) {
                io.sockets.emit('anunciarGanador', { ganador: dataS.id });
                resetJuego();
            }
        } else {
            console.log(`Turno inválido. No es el turno de ${dataS.id}. Es el turno de ${turnoActual}.`);
            console.log(`se repite turno ---> ${turnoActual}`);
        }
    });
    
    // Función para verificar combinaciones ganadoras
    function verificarGanador(ficha) {
        return combinacionesGanadoras.some(combinacion => 
            combinacion.every(index => tablero[index] === ficha)
        );
    }
    
    // Función para reiniciar el juego
    function resetJuego() {
        tablero = Array(9).fill(null); // Reiniciar el tablero

        // turnoActual = 'X'; // O iniciar aleatoriamente
    }

});

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
