const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const dbFile = 'bot.db';
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
    initializeDatabase();
});

function isAdmin(userId) {
    return adminIds.includes(userId);
}

function initializeDatabase() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT,
                credits INTEGER DEFAULT 0,
                emails_sent_today INTEGER DEFAULT 0,
                total_emails_sent INTEGER DEFAULT 0
            )
        `);
        // Updated steps table with `amount_attempts` column
        db.run(`
            CREATE TABLE IF NOT EXISTS steps (
                userId TEXT PRIMARY KEY,
                step TEXT,
                email_attempts INTEGER DEFAULT 0,
                amount_attempts INTEGER DEFAULT 0, -- This is the new line
                email TEXT
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS keys (
                key TEXT PRIMARY KEY,
                credits INTEGER,
                redeemed_by TEXT,
                redeemed_at DATETIME
            )
        `);
        
        db.run(`CREATE INDEX IF NOT EXISTS idx_redeemed_by ON keys (redeemed_by)`);
    });
    console.log('Database initialized with updated structure.');
}

// Call the initialization function to set up the database
initializeDatabase();

// Command: /start
bot.onText(/\/start/, (msg) => {
    const userId = msg.from.id.toString();
    const chatId = msg.chat.id;

    // Check if the user already exists in the database
    db.get("SELECT id FROM users WHERE id = ?", [userId], (err, row) => {
        if (err) {
            bot.sendMessage(chatId, "An error occurred while accessing the database. Please try again later.");
            console.error(err.message);
            return;
        }

        // If the user does not exist, create a new user record
        if (!row) {
            db.run("INSERT INTO users (id, credits, emails_sent_today, total_emails_sent) VALUES (?, 0, 0, 0)", [userId], (err) => {
                if (err) {
                    bot.sendMessage(chatId, "An error occurred while creating your account. Please try again later.");
                    console.error(err.message);
                    return;
                }

                // Welcome message for a new user
                bot.sendMessage(chatId, "Welcome! Your account has been created. Use /help to see available commands.");
            });
        } else {
            // Welcome back message for existing users
            bot.sendMessage(chatId, "Welcome back! Use /help to see available commands.");
        }
    });
});

function validateEmail(email) {
    const re = /^[\w.-]+@[\w.-]+\.\w+$/;
    return re.test(email);
}

bot.onText(/\/sendmail/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
        if (err) {
            bot.sendMessage(chatId, "Error accessing your account. Please try again later.");
            return;
        }

        if (!user) {
            bot.sendMessage(chatId, "Your account is not registered. Please start with /start.");
            return;
        }

        bot.sendMessage(chatId, "Please enter the target email address:");
        db.run("INSERT OR REPLACE INTO steps (userId, step, email_attempts, amount_attempts) VALUES (?, 'input_email', 0, 0)", [userId]);
    });
});

bot.onText(/.*/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    db.get("SELECT * FROM steps WHERE userId = ?", [userId], async (err, row) => {
        if (err || !row) return;

        switch (row.step) {
            case 'input_email':
                if (validateEmail(text)) {
                    bot.sendMessage(chatId, "How many emails do you want to send? (Minimum 50, Maximum 1500)");
                    db.run("UPDATE steps SET email = ?, step = 'input_amount' WHERE userId = ?", [text, userId]);
                } else {
                    if (row.email_attempts >= 1) {
                        bot.sendMessage(chatId, "Invalid email address entered twice. Process canceled.");
                        db.run("DELETE FROM steps WHERE userId = ?", [userId]);
                    } else {
                        bot.sendMessage(chatId, "Invalid email address. Please enter a valid email.");
                        db.run("UPDATE steps SET email_attempts = email_attempts + 1 WHERE userId = ?", [userId]);
                    }
                }
                return;

            case 'input_amount':
                const emailAmount = parseInt(text);
                if (isNaN(emailAmount) || emailAmount < 50 || emailAmount > 1500) {
                    if (row.amount_attempts >= 1) {
                        bot.sendMessage(chatId, "Invalid amount entered twice. Process canceled.");
                        db.run("DELETE FROM steps WHERE userId = ?", [userId]);
                    } else {
                        bot.sendMessage(chatId, "Invalid amount. Please enter a value between 50 and 1500.");
                        db.run("UPDATE steps SET amount_attempts = amount_attempts + 1 WHERE userId = ?", [userId]);
                    }
                    return;
                }

                const creditsNeeded = emailAmount;
                db.get("SELECT credits FROM users WHERE id = ?", [userId], async (err, user) => {
                    if (err || !user) {
                        bot.sendMessage(chatId, "There was a problem retrieving your credit information.");
                        return;
                    }

                    if (creditsNeeded > user.credits) {
                        bot.sendMessage(chatId, "You do not have enough credits to send this many emails. Please recharge.");
                        return;
                    }

                    db.run("UPDATE users SET credits = credits - ? WHERE id = ?", [creditsNeeded, userId], async (error) => {
                        if (error) {
                            bot.sendMessage(chatId, "There was a problem updating your credits. Please try again.");
                            return;
                        }

                        try {
                            const url = `https://emailbomb.cc/api?apikey=${process.env.EBOMB_API_KEY}&action=createTask&email=${encodeURIComponent(row.email)}&amount=${emailAmount}`;
                            const response = await axios.get(url);

                            console.log("API response:", response.data);
                            if (!response.data.error) {
                            // Call to update the total emails sent
                            db.run("UPDATE users SET total_emails_sent = total_emails_sent + ? WHERE id = ?", [emailAmount, userId], (updateErr) => {
                            if (updateErr) {
                            // Log the error and send a failure message to the user
                            console.error("Error when updating total emails sent:", updateErr);
                            bot.sendMessage(chatId, "There was an error updating the total emails sent.");
                    } else {
                            // Send a success message to the user
                            bot.sendMessage(chatId, `Emails sent successfully! You have used ${creditsNeeded} credits.`);
                            }
                        });
                    } else {
                            // Send a failure message to the user and refund credits
                            bot.sendMessage(chatId, "Failed to send emails. Your credits have been refunded.");
                            db.run("UPDATE users SET credits = credits + ? WHERE id = ?", [creditsNeeded, userId]);
                        }
                    } catch (error) {
                            // Log the error and send a failure message to the user
                            console.error("Error during the API call to send emails:", error);
                            bot.sendMessage(chatId, "There was an error sending emails. Your credits have been refunded.");
                            db.run("UPDATE users SET credits = credits + ? WHERE id = ?", [creditsNeeded, userId]);
}

                            // Always delete the step regardless of the outcome above
                            db.run("DELETE FROM steps WHERE userId = ?", [userId]);
                    });
                });
                return;
        }
    });
});

bot.onText(/\/sendsms/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
        if (err) {
            bot.sendMessage(chatId, "Error accessing your account. Please try again later.");
            return;
        }

        if (!user) {
            bot.sendMessage(chatId, "Your account is not registered. Please start with /start.");
            return;
        }

        bot.sendMessage(chatId, "Please enter the target phone number (format: 1234567890@sms.gateway):");
        db.run("INSERT OR REPLACE INTO steps (userId, step, phone_attempts, amount_attempts) VALUES (?, 'input_phone', 0, 0)", [userId]);
    });
});

bot.onText(/.*/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    db.get("SELECT * FROM steps WHERE userId = ?", [userId], async (err, row) => {
        if (err || !row) return;

        switch (row.step) {
            case 'input_phone':
                // Assuming validatePhone is a function you create to validate the phone number format
                if (validatePhone(text)) {
                    bot.sendMessage(chatId, "How many SMS messages do you want to send? (Minimum 10, Maximum 1000)");
                    db.run("UPDATE steps SET phone = ?, step = 'input_sms_amount' WHERE userId = ?", [text, userId]);
                } else {
                    if (row.phone_attempts >= 1) {
                        bot.sendMessage(chatId, "Invalid phone number entered twice. Process canceled.");
                        db.run("DELETE FROM steps WHERE userId = ?", [userId]);
                    } else {
                        bot.sendMessage(chatId, "Invalid phone number. Please enter a valid phone number.");
                        db.run("UPDATE steps SET phone_attempts = phone_attempts + 1 WHERE userId = ?", [userId]);
                    }
                }
                return;

            case 'input_sms_amount':
                const smsAmount = parseInt(text);
                if (isNaN(smsAmount) || smsAmount < 10 || smsAmount > 1000) {
                    if (row.amount_attempts >= 1) {
                        bot.sendMessage(chatId, "Invalid amount entered twice. Process canceled.");
                        db.run("DELETE FROM steps WHERE userId = ?", [userId]);
                    } else {
                        bot.sendMessage(chatId, "Invalid amount. Please enter a value between 10 and 1000.");
                        db.run("UPDATE steps SET amount_attempts = amount_attempts + 1 WHERE userId = ?", [userId]);
                    }
                    return;
                }

                const creditsNeeded = smsAmount;
                db.get("SELECT credits FROM users WHERE id = ?", [userId], async (err, user) => {
                    if (err || !user) {
                        bot.sendMessage(chatId, "There was a problem retrieving your credit information.");
                        return;
                    }

                    if (creditsNeeded > user.credits) {
                        bot.sendMessage(chatId, "You do not have enough credits to send this many SMS messages. Please recharge.");
                        return;
                    }

                    db.run("UPDATE users SET credits = credits - ? WHERE id = ?", [creditsNeeded, userId], async (error) => {
                        if (error) {
                            bot.sendMessage(chatId, "There was a problem updating your credits. Please try again.");
                            return;
                        }

                        try {
                            const url = `https://strike.pw/api/v1/public/attack?apikey=${process.env.STRIKE_API_KEY}&mode=sms&target=${encodeURIComponent(row.phone)}&amount=${smsAmount}`;
                            const response = await axios.get(url);

                            console.log("API response:", response.data);
                            if (!response.data.error) {
                                db.run("UPDATE users SET total_emails_sent = total_emails_sent + ? WHERE id = ?", [smsAmount, userId], (updateErr) => {
                                    if (updateErr) {
                                        console.error("Error when updating total SMS sent:", updateErr);
                                        bot.sendMessage(chatId, "There was an error updating the total SMS sent.");
                                    } else {
                                        bot.sendMessage(chatId, `SMS messages sent successfully! You have used ${creditsNeeded} credits.`);
                                    }
                                });
                            } else {
                                bot.sendMessage(chatId, "Failed to send SMS messages. Your credits have been refunded.");
                                db.run("UPDATE users SET credits = credits + ? WHERE id = ?", [creditsNeeded, userId]);
                            }
                        } catch (error) {
                            console.error("Error during the API call to send SMS:", error);
                            bot.sendMessage(chatId, "There was an error sending SMS messages. Your credits have been refunded.");
                            db.run("UPDATE users SET credits = credits + ? WHERE id = ?", [creditsNeeded, userId]);
                        }

                        db.run("DELETE FROM steps WHERE userId = ?", [userId]);
                    });
                });
                return;
        }
    });
});


bot.onText(/\/info/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    db.get("SELECT credits, total_emails_sent FROM users WHERE id = ?", [userId], (err, user) => {
        if (err) {
            bot.sendMessage(chatId, "There was an error retrieving your information. Please try again later.");
            return;
        }

        if (!user) {
            bot.sendMessage(chatId, "Your account is not registered. Please start with /start.");
            return;
        }

        const creditInfo = `Credits available: ${user.credits}`;
        const emailInfo = `Total emails sent: ${user.total_emails_sent}`;
        bot.sendMessage(chatId, `${creditInfo}\n${emailInfo}`);
    });
});


// Command: /generate (Amount of Emails) (Amount of Keys to generate)
bot.onText(/\/generate (\d+) (\d+)/, (msg, match) => {
    const userId = msg.from.id.toString();
    // This should be adjusted to check if the user is an admin
    // For example, if (admins.includes(userId))
    if (userId === process.env.ADMIN_ID) {
        const emailsPerKey = parseInt(match[1]);
        const numberOfKeys = parseInt(match[2]);

        for (let i = 0; i < numberOfKeys; i++) {
            const key = generateKey();
            db.run("INSERT INTO keys (key, credits) VALUES (?, ?)", [key, emailsPerKey], (err) => {
                if (err) {
                    bot.sendMessage(msg.chat.id, "An error occurred while generating the key.");
                    console.error(err.message);
                } else {
                    bot.sendMessage(msg.chat.id, `Key Generated: ${key}`);
                }
            });
        }
    } else {
        bot.sendMessage(msg.chat.id, "You do not have permission to generate keys.");
    }
});

// Helper function to generate a unique key
function generateKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = '';
    for (let i = 0; i < 16; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

bot.onText(/\/redeem (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const redeemKey = match[1];

    if (!redeemKey) {
        bot.sendMessage(chatId, "Please provide a valid key to redeem.");
        return;
    }

    // Start by checking if the key exists and is valid
    db.get("SELECT * FROM keys WHERE key = ?", [redeemKey], (err, keyRow) => {
        if (err) {
            bot.sendMessage(chatId, "There was an error checking the key. Please try again later.");
            return;
        }

        if (!keyRow) {
            bot.sendMessage(chatId, "The key provided is not valid or has already been used.");
            return;
        }

        // Key is valid, add credits to user
        db.run("BEGIN TRANSACTION");
        db.run("UPDATE users SET credits = credits + ? WHERE id = ?", [keyRow.credits, userId], (updateErr) => {
            if (updateErr) {
                bot.sendMessage(chatId, "There was an error crediting your account. Please try again later.");
                db.run("ROLLBACK");
                return;
            }

            // Remove the key so it can't be used again
            db.run("DELETE FROM keys WHERE key = ?", [redeemKey], (deleteErr) => {
                if (deleteErr) {
                    bot.sendMessage(chatId, "There was an error finalizing the redemption process. Please contact support.");
                    db.run("ROLLBACK");
                    return;
                }

                db.run("COMMIT");
                bot.sendMessage(chatId, `Successfully added ${keyRow.credits} credits to your account.`);
            });
        });
    });
});


// ... Rest of the bot.onText callbacks for handling various commands

// Define a command that will respond with bot information
bot.onText(/\/botinfo/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Define your admin user IDs here
    const adminUsers = [6547925528];

    // Check if the user is an admin
    if (!adminUsers.includes(userId)) {
        bot.sendMessage(chatId, "You are not authorized to use this command.");
        return;
    }

    // Retrieve both the total number of users and the total emails sent
    db.get("SELECT COUNT(*) AS user_count FROM users", (err, userRow) => {
        if (err) {
            bot.sendMessage(chatId, "Error retrieving user count. Please try again later.");
            console.error(err);
            return;
        }

        db.get("SELECT SUM(total_emails_sent) AS email_sum FROM users", (err, emailRow) => {
            if (err) {
                bot.sendMessage(chatId, "Error retrieving total emails sent. Please try again later.");
                console.error(err);
                return;
            }

            // Send a message to the admin with the information
            const userCount = userRow.user_count;
            const emailSum = emailRow.email_sum || 0; // If SUM returns NULL (no rows), default to 0
            bot.sendMessage(
                chatId,
                `Bot Information:\n- Total Users: ${userCount}\n- Total Emails Sent: ${emailSum}`
            );
        });
    });
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Listen for the "/help" command
    if (text === '/help') {
        const helpMessage = `
Here are the commands you can use:
- /start -> Starts the Bot and gives you a brief introduction.
- /send -> Initiates the email sending process.
- /info -> Provides information about your profile.
- /redeem -> Allows you to redeem a key to add credits to your account.

Just type any of the above commands to get started!
`;
        bot.sendMessage(chatId, helpMessage);
    }
});

// Function to retrieve leaderboard
function retrieveLeaderboard() {
    return new Promise((resolve, reject) => {
        const query = "SELECT id, total_emails_sent FROM users ORDER BY total_emails_sent DESC LIMIT 10";
        db.all(query, [], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

// Bot command to display leaderboard
bot.onText(/\/leaderboard/, (msg) => {
    retrieveLeaderboard()
        .then(leaderboard => {
            let message = "🏆 Top 10 Users (Total Mails sent) 🏆\n";
            leaderboard.forEach((user, index) => {
                message += `${index + 1}. User ID: ${user.id} - ${user.total_emails_sent} emails\n`;
            });
            bot.sendMessage(msg.chat.id, message);
        })
        .catch(error => {
            console.error("Error retrieving leaderboard:", error);
            bot.sendMessage(msg.chat.id, "Sorry, there was an error retrieving the leaderboard.");
        });
});



// Remember to close the database when the bot shuts down
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Closed the database connection.');
        process.exit(0);
    });
});
