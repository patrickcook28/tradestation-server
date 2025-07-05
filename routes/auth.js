const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const logger = require("../config/logging");

const register = async (req, res) => {
    const { email, password, password_confirm } = req.body;

    pool.query('SELECT email FROM users WHERE email = $1', [email], async (error, result) => {
        if(error){
            return res.status(400).json({ error: 'Failed to check if user exists' })
        } else if( result.rows.length > 0 ) {
            return res.status(400).json({ error: 'Email is already in use' })
        } else if(password !== password_confirm) {
            return res.status(400).json({ error: 'Password Didn\'t Match!'})
        }

        let hashedPassword = await bcrypt.hash(password, 8)

        pool.query('INSERT INTO users (email, password) VALUES ($1, $2)',[email, hashedPassword], (error, result) => {
            if(error) {
                return res.status(400).json({ error: 'Failed to create new user' })
            } else {
                return res.json()
            }
        })        
    })
};

const login = async (req, res) => {
    const { email, password } = req.body;

    pool.query('SELECT * FROM users WHERE email = $1', [email], async (error, result) => {
        if(error){
            return res.status(400).json({ error: 'Failed to check if user exists' })
        } else if( result.rows.length === 0 ) {
            return res.status(400).json({ error: 'User not found' })
        }

        let user = result.rows[0]

        let isMatch = await bcrypt.compare(password, user.password)

        if(!isMatch){
            return res.status(400).json({ error: 'Invalid credentials' })
        }

        let token = jwt.sign({ id: user.id }, process.env.JWT_SECRET)

        return res.json({
            token,
            user: {
                id: user.id,
                email: user.email
            }
        })
    })
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
    logger.auth(req.method, req.path, 'Token Missing');
    return res.sendStatus(401); // if there isn't any token
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      logger.auth(req.method, req.path, 'Failed', null);
      return res.sendStatus(403);
    }
    logger.auth(req.method, req.path, 'Success', user.id);
    req.user = user;
    next();
  });
};

module.exports = {
    register,
    login,
    authenticateToken
};
