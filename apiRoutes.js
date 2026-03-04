const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const router = express.Router();
const path = require("path");
const os = require("os");
const fs = require("fs");
const sqlite3 = require("sqlite3");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const { authenticateUser } = require("./middleware/authMiddleware");
const cors = require("cors");

const ACCESS_TOKEN_SECRET =
  "eae4d501a41a3efaf5c904fcf617fb1eac4823ad92ffa24b1b6de67bc25b9caabf4c921d734001d1d3968be4f0072ab49ca60efd407fe5cd465c85c06a28d3cd";
const REFRESH_TOKEN_SECRET =
  "d0cd50a24fae17c189a35fc98a3453fa6aad566b6c4d6e9b8c7a9446a2bd20aba535beee26d08b2c0de9e72db513fded3a48d2919971ee99ac999ce3957fb369";
const TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";

// 🔹 Define a writable path for the database
const dataPath = path.join(os.homedir(), "myapp_data");
if (!fs.existsSync(dataPath)) {
  fs.mkdirSync(dataPath, { recursive: true });
}
const dbPath = "shopdb.sqlite";

// 🔹 Open SQLite database from the writable location
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
  } else {
    console.log("Connected to the SQLite database at:", dbPath);
  }
});

router.use(express.json());
router.use(express.urlencoded({ extended: true })); // Also handles form data

router.use((req, res, next) => {
  res.setTimeout(60000, () => {
    // Set timeout to 60 seconds
    res.status(408).send("Request timeout");
  });
  next();
});
router.use(
  cors({
    origin: true,
    credentials: true, // Allows cookies and authentication headers
  })
);

// Ensure `uploads` directory exists
const uploadsDir = path.join(os.homedir(), "myapp_uploads", "images");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true }); // Create writable folder outside the EXE
}

const documentsDir = path.join(os.homedir(), "myapp_uploads", "documents");
if (!fs.existsSync(documentsDir)) {
  fs.mkdirSync(documentsDir, { recursive: true });
}
// Serve static files from the `uploads` directory
router.use("/uploads", express.static(uploadsDir));
router.use("/uploads/documents", express.static(documentsDir));
router.use(cookieParser());
// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// Configure Multer for file uploads specifically for documents
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, documentsDir); // Save documents to the 'uploads/documents' folder
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // Unique filename with extension
  },
});

const documentUpload = multer({ storage: documentStorage });

// Generate Token Functions
const generateAccessToken = (user) => {
  return jwt.sign({ id: user.id, email: user.email }, ACCESS_TOKEN_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  });
};

const generateRefreshToken = (user) => {
  return jwt.sign({ id: user.id, email: user.email }, REFRESH_TOKEN_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
};

// REGISTER
// REGISTER NEW USER (Only Admins)
router.post("/register", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { email, username, phone, password } = req.body;

  // Check required fields early
  if (!email || !username || !phone || !password) {
    return res.status(400).json({ error: "All fields are required." });
  }

  // Validate email format
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email format." });
  }
  db.get(
    `SELECT email, username, phone, role FROM users WHERE id = ?`,
    [userId],
    async (err, currentUser) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!currentUser)
        return res.status(404).json({ error: "User not found" });

      // Only admin users can register new users
      if (currentUser.role !== "admin") {
        return res
          .status(403)
          .json({ error: "Forbidden. Only admins can create users." });
      }

      try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run(
          `INSERT INTO users (email, username, phone, password, role,status) VALUES (?, ?, ?, ?, ?,?)`,
          [email, username, phone, hashedPassword, "user", "active"],
          (err) => {
            if (err)
              return res.status(500).json({ error: "Registration failed." });
            res.json({ message: "User registered successfully!" });
          }
        );
      } catch (hashError) {
        res.status(500).json({ error: "Password hashing failed." });
      }
    }
  );
});

// LOGIN
router.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required." });

  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user)
      return res.status(400).json({ error: "Invalid email or password." });

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch)
      return res.status(400).json({ error: "Invalid email or password." });

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    });
    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        phone: user.phone,
        role: user.role, // Include role in the response
      },
    });
  });
});

// REFRESH TOKEN
router.post("/refresh", (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken)
    return res.status(403).json({ error: "Refresh token required." });

  jwt.verify(refreshToken, REFRESH_TOKEN_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid refresh token." });

    const newAccessToken = generateAccessToken(user);
    res.json({ accessToken: newAccessToken });
  });
});

// LOGOUT
router.post("/logout", (req, res) => {
  res.clearCookie("refreshToken");
  res.json({ message: "Logged out successfully" });
});

const logAuditTrail = (req, db, tableName, recordId, action, changes) => {
  if (!req.user || !req.user.id) {
    console.error("Error: User ID not found in request.");
    return;
  }

  const userId = req.user.id; // Get user ID from authenticated request
  const query = `
      INSERT INTO audit_trails (user_id, table_name, record_id, action, changes)
      VALUES (?, ?, ?, ?, ?)
    `;

  const changesJson = JSON.stringify(changes || {});

  db.run(query, [userId, tableName, recordId, action, changesJson], (err) => {
    if (err) {
      console.error("Error logging audit trail:", err.message);
    } else {
      console.log(
        `Audit trail logged for ${action} on ${tableName} (Record ID: ${recordId}) by User ID: ${userId}`
      );
    }
  });
};

// ===================== Profile Endpoints =====================
// GET USER PROFILE
router.get("/profile", authenticateUser, (req, res) => {
  const userId = req.user.id;
  console.log("this is user id", userId);

  db.get(
    `SELECT id, email, username, phone, role FROM users WHERE id = ?`,
    [userId],
    (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: "User not found." });
      }
      res.json(user);
    }
  );
});

// UPDATE PROFILE (email, username, phone, role)
router.put("/profile", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { email, username, phone, role } = req.body;

  // Validate at least one field is provided
  if (!email && !username && !phone && !role) {
    return res
      .status(400)
      .json({ error: "At least one field to update is required." });
  }

  // First get complete user data including role
  db.get(
    `SELECT email, username, phone, role FROM users WHERE id = ?`,
    [userId],
    async (err, currentUser) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!currentUser)
        return res.status(404).json({ error: "User not found" });

      // Validate email format if provided
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Invalid email format." });
      }

      // Check if email exists (excluding current user)
      if (email && email !== currentUser.email) {
        const emailExists = await new Promise((resolve) => {
          db.get(
            `SELECT id FROM users WHERE email = ? AND id != ?`,
            [email, userId],
            (err, row) => {
              resolve(!!row);
            }
          );
        });

        if (emailExists) {
          return res.status(400).json({ error: "Email already in use." });
        }
      }

      // Only allow role changes if current user is admin
      if (role && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Only admins can change roles." });
      }

      // Validate role value if provided
      if (role && !["admin", "user"].includes(role)) {
        return res.status(400).json({ error: "Invalid role specified." });
      }

      // Prepare changes for audit trail
      const changes = {};
      if (email && email !== currentUser.email) changes.email = email;
      if (username && username !== currentUser.username)
        changes.username = username;
      if (phone && phone !== currentUser.phone) changes.phone = phone;
      if (role && role !== currentUser.role && currentUser.role === "admin")
        changes.role = role;

      if (Object.keys(changes).length === 0) {
        return res.status(400).json({ error: "No changes detected." });
      }

      // Update user in database
      db.run(
        `UPDATE users SET 
        email = COALESCE(?, email),
        username = COALESCE(?, username), 
        phone = COALESCE(?, phone),
        role = CASE WHEN ? = 'admin' THEN ? ELSE role END
       WHERE id = ?`,
        [
          email,
          username,
          phone,
          currentUser.role, // Use role from database
          role,
          userId,
        ],
        function (err) {
          if (err) return res.status(500).json({ error: "Update failed." });

          // Log audit trail
          logAuditTrail(req, db, "users", userId, "update", changes);

          res.json({
            message: "Profile updated successfully!",
            updatedFields: Object.keys(changes),
            newEmail: email && email !== currentUser.email ? email : undefined,
          });
        }
      );
    }
  );
});
// CHANGE PASSWORD
router.put("/change-password", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res
      .status(400)
      .json({ error: "Both current and new password are required." });
  }

  if (currentPassword === newPassword) {
    return res
      .status(400)
      .json({ error: "New password must be different from current password." });
  }

  // Verify current password
  db.get(
    `SELECT password FROM users WHERE id = ?`,
    [userId],
    async (err, user) => {
      if (err || !user)
        return res.status(404).json({ error: "User not found." });

      const passwordMatch = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!passwordMatch) {
        return res
          .status(400)
          .json({ error: "Current password is incorrect." });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      db.run(
        `UPDATE users SET password = ? WHERE id = ?`,
        [hashedPassword, userId],
        function (err) {
          if (err)
            return res.status(500).json({ error: "Password change failed." });

          // Log audit trail
          logAuditTrail(req, db, "users", userId, "change_password", {});

          res.json({ message: "Password changed successfully!" });
        }
      );
    }
  );
});

// ===================== User Management Endpoints =====================

// GET /users - List all users
router.get("/users", authenticateUser, (req, res) => {
  db.all(
    `SELECT id, email, username, phone, role, status FROM users`,
    (err, rows) => {
      if (err)
        return res.status(500).json({ error: "Failed to retrieve users." });
      res.json(rows);
    }
  );
});

// PUT /users/:id - Update user
router.put("/users/:id", authenticateUser, (req, res) => {
  const userId = req.params.id;
  const { email, username, phone, role } = req.body;

  db.run(
    `UPDATE users SET 
      email = COALESCE(?, email), 
      username = COALESCE(?, username),
      phone = COALESCE(?, phone), 
      role = COALESCE(?, role)
    WHERE id = ?`,
    [email, username, phone, role, userId],
    function (err) {
      if (err) return res.status(500).json({ error: "Failed to update user." });

      logAuditTrail(req, db, "users", userId, "update", req.body);
      res.json({ message: "User updated successfully." });
    }
  );
});

// DELETE /users/:id - Delete user
router.delete("/users/:id", authenticateUser, (req, res) => {
  const userId = req.params.id;

  db.run(`DELETE FROM users WHERE id = ?`, [userId], function (err) {
    if (err) return res.status(500).json({ error: "Failed to delete user." });

    logAuditTrail(req, db, "users", userId, "delete", {});
    res.json({ message: "User deleted successfully." });
  });
});

// PUT /users/:id/status - Toggle user status
router.put("/users/:id/status", authenticateUser, (req, res) => {
  const userId = req.params.id;

  db.get(`SELECT status FROM users WHERE id = ?`, [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: "User not found." });

    const newStatus = user.status === "active" ? "inactive" : "active";

    db.run(
      `UPDATE users SET status = ? WHERE id = ?`,
      [newStatus, userId],
      function (err) {
        if (err)
          return res
            .status(500)
            .json({ error: "Failed to update user status." });

        logAuditTrail(req, db, "users", userId, "update", { newStatus });
        res.json({ message: `User status updated to ${newStatus}.` });
      }
    );
  });
});

// ===================== Products Endpoints =====================

// Get all products
// Get all products with quantity in stock from inventory
router.get("/products", (req, res) => {
  const query = `
      SELECT 
        products.id, 
        products.name, 
        products.cp, 
        products.sp, 
        products.image, 
        products.suppliers_id,
        IFNULL(SUM(inventory.quantity_in_stock), 0) AS quantity_in_stock
      FROM products
      LEFT JOIN inventory ON products.id = inventory.product_id
      GROUP BY products.id
    `;

  db.all(query, (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).send("Error fetching products");
    } else {
      res.json(rows);
    }
  });
});

// Get a specific product by ID with quantity in stock from inventory
router.get("/products/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const query = `
      SELECT 
        products.id, 
        products.name, 
        products.cp, 
        products.sp, 
        products.image, 
        products.suppliers_id,
        IFNULL(SUM(inventory.quantity_in_stock), 0) AS quantity_in_stock
      FROM products
      LEFT JOIN inventory ON products.id = inventory.product_id
      WHERE products.id = ?
      GROUP BY products.id
    `;

  db.get(query, [id], (err, row) => {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error fetching product");
    } else if (!row) {
      res.status(404).send("Product not found");
    } else {
      res.json(row);
    }
  });
});
router.post("/products/bulk", authenticateUser, (req, res) => {
  const { suppliers_id, products } = req.body;

  // Validate input
  if (!suppliers_id) {
    return res.status(400).send("Supplier ID is required.");
  }

  if (!Array.isArray(products) || products.length === 0) {
    return res
      .status(400)
      .send("Products array is required and cannot be empty.");
  }

  const invalidProduct = products.find(
    (product) =>
      !product.name ||
      isNaN(product.cp) ||
      isNaN(product.sp) ||
      product.cp < 0 ||
      product.sp < 0
  );

  if (invalidProduct) {
    return res
      .status(400)
      .send(
        "Each product must have a name, cp, and sp with non-negative values."
      );
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    let errorOccurred = false;
    const inventoryInserts = [];
    const auditLogs = [];

    products.forEach((product) => {
      const stmt = db.prepare(
        "INSERT INTO products (name, cp, sp, suppliers_id) VALUES (?, ?, ?, ?)"
      );

      stmt.run(
        product.name,
        product.cp,
        product.sp,
        suppliers_id,
        function (err) {
          if (err) {
            console.error("Error inserting product:", err.message);
            errorOccurred = true;
          } else {
            const productId = this.lastID;

            // Collect audit log data
            auditLogs.push({
              table: "products",
              recordId: productId,
              action: "insert",
              changes: product,
            });

            // Prepare inventory entry for the newly added product
            inventoryInserts.push(
              new Promise((resolve, reject) => {
                db.run(
                  "INSERT INTO inventory (product_id, quantity_in_stock, cost_per_unit) VALUES (?, ?, ?)",
                  [productId, 0, product.cp],
                  (err) => {
                    if (err) {
                      console.error(
                        "Error inserting into inventory:",
                        err.message
                      );
                      return reject(err);
                    }
                    resolve();
                  }
                );
              })
            );
          }
        }
      );

      stmt.finalize();
    });

    // Wait for all inventory entries to be created
    Promise.all(inventoryInserts)
      .then(() => {
        if (errorOccurred) {
          db.run("ROLLBACK");
          return res
            .status(500)
            .send("Failed to add products. Transaction rolled back.");
        }

        // Log all audit trails after successful commit
        db.run("COMMIT", () => {
          auditLogs.forEach(({ table, recordId, action, changes }) => {
            logAuditTrail(req, db, table, recordId, action, changes);
          });

          res
            .status(201)
            .send("Products and inventory entries added successfully.");
        });
      })
      .catch((err) => {
        console.error("Error during inventory insertion:", err.message);
        db.run("ROLLBACK");
        res
          .status(500)
          .send("Failed to add inventory entries. Transaction rolled back.");
      });
  });
});

// Add a new product
router.post(
  "/products",
  upload.single("image"),
  authenticateUser,
  (req, res) => {
    const { name, cp, sp, suppliers_id } = req.body;
    const imagePath = req.file ? `/uploads/images/${req.file.filename}` : null;

    // Validation: Ensure required fields are provided and constraints are respected
    if (!name || cp < 0 || sp < 0 || !suppliers_id) {
      return res
        .status(400)
        .send("Invalid product data. Please check your inputs.");
    }

    const stmt = db.prepare(
      "INSERT INTO products (name, cp, sp, image, suppliers_id) VALUES (?, ?, ?, ?, ?)"
    );
    stmt.run(name, cp, sp, imagePath, suppliers_id, function (err) {
      if (err) {
        console.error(err.message);
        res.status(500).send("Error adding product");
      } else {
        res.status(201).json({
          id: this.lastID,
          name,
          cp,
          sp,
          image: imagePath,
          suppliers_id,
        });
      }
    });
  }
);

// Update a product
router.put(
  "/products/:id",
  upload.single("image"),
  authenticateUser,
  (req, res) => {
    const { id } = req.params;
    const { name, cp, sp, suppliers_id } = req.body;
    const imagePath = req.file ? `/uploads/images/${req.file.filename}` : null;

    const fields = [];
    const values = [];

    // Dynamically add fields for update based on input
    if (name) {
      fields.push("name = ?");
      values.push(name);
    }
    if (cp >= 0) {
      fields.push("cp = ?");
      values.push(cp);
    }
    if (sp >= 0) {
      fields.push("sp = ?");
      values.push(sp);
    }
    if (suppliers_id) {
      fields.push("suppliers_id = ?");
      values.push(suppliers_id);
    }
    if (imagePath) {
      fields.push("image = ?");
      values.push(imagePath);
    }

    if (fields.length === 0) {
      return res.status(400).send("No valid fields provided for update.");
    }

    values.push(id);

    const query = `UPDATE products SET ${fields.join(", ")} WHERE id = ?`;

    db.run(query, values, function (err) {
      if (err) {
        console.error(err.message);
        res.status(500).send("Error updating product");
      } else if (this.changes === 0) {
        res.status(404).send("Product not found");
      } else {
        res.json({
          id,
          name,
          cp,
          sp,
          image: imagePath,
          suppliers_id,
        });
      }
    });
  }
);

// Delete a product
router.delete("/products/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM products WHERE id = ?", [id], function (err) {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error deleting product");
    } else if (this.changes === 0) {
      res.status(404).send("Product not found");
    } else {
      res.status(204).send();
    }
  });
});

// ===================== Inventoty Endpoints =====================
// Create Inventory
router.post("/inventory", authenticateUser, (req, res) => {
  const { product_id, quantity_in_stock, cost_per_unit } = req.body;

  if (!product_id || !quantity_in_stock || !cost_per_unit) {
    return res.status(400).send("Missing required fields.");
  }

  const stmt = db.prepare(
    `INSERT INTO inventory (product_id, quantity_in_stock, cost_per_unit) 
       VALUES (?, ?, ?)`
  );

  stmt.run(product_id, quantity_in_stock, cost_per_unit, function (err) {
    if (err) {
      return res.status(500).send("Failed to add inventory.");
    }

    const inventoryId = this.lastID;

    // Log audit trail
    logAuditTrail(req, db, "inventory", inventoryId, "insert", {
      product_id,
      quantity_in_stock,
      cost_per_unit,
    });

    res.status(201).json({
      id: inventoryId,
      product_id,
      quantity_in_stock,
      cost_per_unit,
    });
  });
});

// Read All Inventory Items
router.get("/inventory", authenticateUser, (req, res) => {
  db.all("SELECT * FROM inventory", [], (err, rows) => {
    if (err) {
      return res.status(500).send("Failed to retrieve inventory.");
    }
    res.status(200).json(rows);
  });
});

// Read Single Inventory Item by ID
router.get("/inventory/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  db.get("SELECT * FROM inventory WHERE id = ?", [id], (err, row) => {
    if (err) {
      return res.status(500).send("Failed to retrieve inventory item.");
    }
    if (!row) {
      return res.status(404).send("Inventory item not found.");
    }
    res.status(200).json(row);
  });
});
// Create Inventory
router.post("/inventory", authenticateUser, (req, res) => {
  const { product_id, quantity_in_stock, cost_per_unit } = req.body;

  if (!product_id || !quantity_in_stock || !cost_per_unit) {
    return res.status(400).send("Missing required fields.");
  }

  const stmt = db.prepare(
    `INSERT INTO inventory (product_id, quantity_in_stock, cost_per_unit) 
       VALUES (?, ?, ?)`
  );

  stmt.run(product_id, quantity_in_stock, cost_per_unit, function (err) {
    if (err) {
      return res.status(500).send("Failed to add inventory.");
    }

    const inventoryId = this.lastID;

    // Log audit trail
    logAuditTrail(req, db, "inventory", inventoryId, "insert", {
      product_id,
      quantity_in_stock,
      cost_per_unit,
    });

    res.status(201).json({
      id: inventoryId,
      product_id,
      quantity_in_stock,
      cost_per_unit,
    });
  });
});
// Update Inventory
router.put("/inventory/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { product_id, quantity_in_stock, cost_per_unit } = req.body;

  if (!product_id || !quantity_in_stock || !cost_per_unit) {
    return res.status(400).send("Missing required fields.");
  }

  const stmt = db.prepare(
    `UPDATE inventory 
       SET product_id = ?, quantity_in_stock = ?, cost_per_unit = ? 
       WHERE id = ?`
  );

  stmt.run(product_id, quantity_in_stock, cost_per_unit, id, function (err) {
    if (err) {
      return res.status(500).send("Failed to update inventory.");
    }
    if (this.changes === 0) {
      return res.status(404).send("Inventory item not found.");
    }

    // Log audit trail
    logAuditTrail(req, db, "inventory", id, "update", {
      product_id,
      quantity_in_stock,
      cost_per_unit,
    });

    res.status(200).send("Inventory item updated successfully.");
  });
});

// Delete Inventory Item
router.delete("/inventory/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  const stmt = db.prepare("DELETE FROM inventory WHERE id = ?");

  stmt.run(id, function (err) {
    if (err) {
      return res.status(500).send("Failed to delete inventory item.");
    }
    if (this.changes === 0) {
      return res.status(404).send("Inventory item not found.");
    }

    // Log audit trail
    logAuditTrail(req, db, "inventory", id, "delete", {});

    res.status(200).send("Inventory item deleted successfully.");
  });
});

// Get all purchase orders
router.get("/purchase_orders", authenticateUser, (req, res) => {
  db.all("SELECT * FROM purchase_orders ORDER BY id DESC", (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).send("Error fetching purchase orders");
    } else {
      res.json(rows);
    }
  });
});

// Get a single purchase order by ID
router.get("/purchase_orders/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  db.get("SELECT * FROM purchase_orders WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error(err);
      res.status(500).send("Error fetching purchase order");
    } else if (!row) {
      res.status(404).send("Purchase order not found");
    } else {
      res.json(row);
    }
  });
});
router.patch(
  "/purchase_orders/:id/order_status",
  authenticateUser,
  async (req, res) => {
    const { id } = req.params;
    const { order_status, reference_number } = req.body;
    const user_id = req.user.id; // Get the logged-in user ID

    if (!["pending", "received", "cancelled"].includes(order_status)) {
      return res.status(400).send("Invalid status.");
    }

    try {
      const row = await new Promise((resolve, reject) => {
        db.get(
          `SELECT order_status FROM purchase_orders WHERE id = ?`,
          [id],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!row) return res.status(404).send("Purchase order not found.");

      const oldStatus = row.order_status;
      if (oldStatus === order_status)
        return res.status(400).send("Status is already updated.");

      // Process status change
      if (order_status === "received") {
        const items = await new Promise((resolve, reject) => {
          db.all(
            `SELECT product_id, quantity, unit_price FROM purchase_order_details WHERE purchase_order_id = ?`,
            [id],
            (err, items) => {
              if (err) reject(err);
              else resolve(items);
            }
          );
        });

        if (items.length === 0)
          return res
            .status(404)
            .send("No items found for this purchase order.");

        let totalValue = 0;
        const inventoryUpdates = items.map(
          ({ product_id, quantity, unit_price }) => {
            totalValue += quantity * unit_price;
            return new Promise((resolve, reject) => {
              db.run(
                `UPDATE inventory SET quantity_in_stock = quantity_in_stock + ?, cost_per_unit = ? WHERE product_id = ?`,
                [quantity, unit_price, product_id],
                (err) => {
                  if (err) reject(err);
                  else resolve();
                }
              );
            });
          }
        );

        await Promise.all(inventoryUpdates);

        const journalEntryId = await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, date('now'), ?, 'posted')`,
            [reference_number, `Purchase order #${id} received`],
            function (err) {
              if (err) reject(err);
              else resolve(this.lastID);
            }
          );
        });

        const journalLines = [
          {
            journal_entry_id: journalEntryId,
            account_id: 3,
            debit: totalValue,
            credit: 0,
            isLiability: false,
          },
          {
            journal_entry_id: journalEntryId,
            account_id: 5,
            debit: 0,
            credit: totalValue,
            isLiability: true,
          },
        ];

        await Promise.all(
          journalLines.map(
            (line) =>
              new Promise((resolve, reject) => {
                db.run(
                  `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                  [
                    line.journal_entry_id,
                    line.account_id,
                    line.debit,
                    line.credit,
                  ],
                  (err) => {
                    if (err) reject(err);
                    else resolve();
                  }
                );
              })
          )
        );

        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE purchase_orders SET order_status = ? WHERE id = ?`,
            [order_status, id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        const changes = JSON.stringify({
          old_status: oldStatus,
          new_status: order_status,
        });
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO audit_trails (user_id, table_name, record_id, action, changes) VALUES (?, ?, ?, ?, ?)`,
            [user_id, "purchase_orders", id, "update", changes],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        res.send("Status updated and records updated successfully.");
      } else {
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE purchase_orders SET order_status = ? WHERE id = ?`,
            [order_status, id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        const changes = JSON.stringify({
          old_status: oldStatus,
          new_status: order_status,
        });
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO audit_trails (user_id, table_name, record_id, action, changes) VALUES (?, ?, ?, ?, ?)`,
            [user_id, "purchase_orders", id, "update", changes],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        res.send("Status updated successfully.");
      }
    } catch (error) {
      console.error("Error processing purchase order:", error);
      res
        .status(500)
        .send("An error occurred while processing the purchase order.");
    }
  }
);
router.put("/purchase_orders/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { reference_number, supplier_id, total_amount } = req.body;
  const user_id = req.user.id; // Get the logged-in user ID

  const query =
    "UPDATE purchase_orders SET reference_number = ?, supplier_id = ?, total_amount = ? WHERE id = ?";
  db.run(
    query,
    [reference_number, supplier_id, total_amount, id],
    function (err) {
      if (err) {
        console.error(err.message);
        res.status(500).send("Error updating purchase order");
      } else if (this.changes === 0) {
        res.status(404).send("Purchase order not found");
      } else {
        const changes = JSON.stringify({
          reference_number,
          supplier_id,
          total_amount,
        });

        db.run(
          `INSERT INTO audit_trails (user_id, table_name, record_id, action, changes) VALUES (?, ?, ?, ?, ?)`,
          [user_id, "purchase_orders", id, "update", changes],
          (err) => {
            if (err) console.error(err);
          }
        );

        res.json({ id, reference_number, supplier_id, total_amount });
      }
    }
  );
});
router.delete("/purchase_orders/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const user_id = req.user.id; // Get the logged-in user ID

  db.get(
    `SELECT supplier_id, total_amount FROM purchase_orders WHERE id = ?`,
    [id],
    (err, purchaseOrder) => {
      if (err) {
        console.error("Error fetching purchase order:", err);
        return res.status(500).send("Error deleting purchase order.");
      }

      if (!purchaseOrder)
        return res.status(404).send("Purchase order not found.");

      db.run(`DELETE FROM purchase_orders WHERE id = ?`, [id], (err) => {
        if (err) {
          console.error("Error deleting purchase order:", err);
          return res.status(500).send("Error deleting purchase order.");
        }

        db.run(
          `UPDATE suppliers SET total_purchase_due = total_purchase_due - ? WHERE id = ?`,
          [purchaseOrder.total_amount, purchaseOrder.supplier_id],
          (err) => {
            if (err) {
              console.error(
                "Error updating supplier's total_purchase_due:",
                err
              );
              return res
                .status(500)
                .send("Error updating supplier's total_purchase_due.");
            }

            const changes = JSON.stringify({
              supplier_id: purchaseOrder.supplier_id,
              total_amount: purchaseOrder.total_amount,
            });
            db.run(
              `INSERT INTO audit_trails (user_id, table_name, record_id, action, changes) VALUES (?, ?, ?, ?, ?)`,
              [user_id, "purchase_orders", id, "delete", changes],
              (err) => {
                if (err) console.error(err);
              }
            );

            res.send(
              "Purchase order deleted and supplier's total_purchase_due updated."
            );
          }
        );
      });
    }
  );
});
// Create Purchase Order
router.post("/purchase_orders", authenticateUser, (req, res) => {
  const { reference_number, supplier_id, total_amount, status, items } =
    req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).send("Product details are required");
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    // Insert items into the temporary table
    const stmt = db.prepare(
      "INSERT INTO temp_purchase_order_items (product_id, quantity, unit_price) VALUES (?, ?, ?)"
    );

    items.forEach((item) => {
      const { product_id, quantity, unit_price } = item;
      stmt.run(product_id, quantity, unit_price, (err) => {
        if (err) {
          console.error("Error inserting item into temp table:", err.message);
        }
      });
    });

    stmt.finalize();

    // Insert the purchase order
    const purchaseOrderStmt = db.prepare(
      "INSERT INTO purchase_orders (reference_number, supplier_id, total_amount, order_status, payment_status) VALUES (?, ?, ?, ?, ?)"
    );

    purchaseOrderStmt.run(
      reference_number,
      supplier_id,
      total_amount,
      status || "pending",
      "unpaid",
      function (err) {
        if (err) {
          console.error(err.message);
          db.run("ROLLBACK");
          return res.status(500).send("Error creating purchase order");
        }

        const purchase_order_id = this.lastID;
        db.run("COMMIT");

        // Log audit trail
        logAuditTrail(req, db, "purchase_orders", purchase_order_id, "insert", {
          reference_number,
          supplier_id,
          total_amount,
          order_status: status || "pending",
          payment_status: "unpaid",
        });

        res.status(201).json({
          id: purchase_order_id,
          reference_number,
          supplier_id,
          total_amount,
          order_status: status || "pending",
          payment_status: "unpaid",
        });
      }
    );
  });
});

// Get purchase order details by purchase order ID
router.get("/purchase_orders/:id/details", authenticateUser, (req, res) => {
  const { id } = req.params;

  db.all(
    `SELECT pod.id, pod.product_id, p.name, pod.quantity, pod.unit_price
       FROM purchase_order_details pod
       JOIN products p ON pod.product_id = p.id
       WHERE pod.purchase_order_id = ?`,
    [id],
    (err, rows) => {
      if (err) {
        console.error(err.message);
        res.status(500).send("Error fetching purchase order details");
      } else {
        res.json(rows);
      }
    }
  );
});

// Delete purchase order detail
router.delete(
  "/purchase_orders_with_details/:purchase_order_id/details/:detail_id",
  authenticateUser,
  (req, res) => {
    const { purchase_order_id, detail_id } = req.params;
    const userId = req.user.id; // Get user ID from authenticateUser middleware

    const query = `DELETE FROM purchase_order_details
                     WHERE product_id = ? AND purchase_order_id = ?`;

    db.run(query, [detail_id, purchase_order_id], function (err) {
      if (err) {
        console.error(err.message);
        res.status(500).send("Error deleting purchase order detail");
      } else if (this.changes === 0) {
        res.status(404).send("Purchase order detail not found");
      } else {
        // Log audit trail
        logAuditTrail(req, db, "purchase_order_details", detail_id, "delete", {
          purchase_order_id,
          product_id: detail_id,
        });

        res.status(200).send("Purchase order detail deleted successfully");
      }
    });
  }
);

// Update a purchase order detail
router.put(
  "/purchase_orders_with_details/:purchase_order_id/details/:detail_id",
  authenticateUser,
  (req, res) => {
    const { purchase_order_id, detail_id } = req.params;
    const { quantity, unit_price } = req.body;
    const userId = req.user.id; // Get user ID from authenticateUser middleware

    const query = `UPDATE purchase_order_details
                     SET quantity = ?, unit_price = ?
                     WHERE product_id = ? AND purchase_order_id = ?`;

    db.run(
      query,
      [quantity, unit_price, detail_id, purchase_order_id],
      function (err) {
        if (err) {
          console.error(err.message);
          res.status(500).send("Error updating purchase order details");
        } else if (this.changes === 0) {
          res.status(404).send("Purchase order detail not found");
        } else {
          // Log audit trail after successful update
          logAuditTrail(
            req,
            db,
            "purchase_order_details",
            detail_id,
            "update",
            {
              purchase_order_id,
              quantity,
              unit_price,
            }
          );

          res.json({
            purchase_order_id,
            detail_id,
            quantity,
            unit_price,
          });
        }
      }
    );
  }
);

// Add a new purchase order detail
router.post(
  "/purchase_orders_with_details/:purchase_order_id/details",
  authenticateUser,
  (req, res) => {
    const { purchase_order_id } = req.params;
    const { product_id, quantity, unit_price } = req.body;
    const userId = req.user.id; // Get user ID from authenticateUser middleware

    // Ensure all required fields are provided
    if (!product_id || !quantity || !unit_price) {
      return res
        .status(400)
        .send("Product ID, quantity, and unit price are required");
    }

    const query = `INSERT INTO purchase_order_details (purchase_order_id, product_id, quantity, unit_price)
                     VALUES (?, ?, ?, ?)`;

    db.run(
      query,
      [purchase_order_id, product_id, quantity, unit_price],
      function (err) {
        if (err) {
          console.error(err.message);
          res.status(500).send("Error adding purchase order detail");
        } else {
          const detailId = this.lastID;

          // Log audit trail after successful insertion
          logAuditTrail(req, db, "purchase_order_details", detailId, "insert", {
            purchase_order_id,
            product_id,
            quantity,
            unit_price,
          });

          res.status(201).json({
            purchase_order_id,
            product_id,
            quantity,
            unit_price,
            id: detailId,
          });
        }
      }
    );
  }
);

// ===================== Accounts Endpoints =====================
// Get all accounts
router.get("/accounts", authenticateUser, (req, res) => {
  db.all(
    "SELECT * FROM chart_of_accounts ORDER BY account_name ASC",
    [],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json(rows);
      }
    }
  );
});


router.post("/accounts", authenticateUser, (req, res) => {
  const { account_name, account_type, balance, parent_account_id,balance_type, date } =
    req.body;
  const userId = req.user.id; // Get user ID from authenticateUser middleware

  if (!account_name || !account_type) {
    return res
      .status(400)
      .json({ error: "Account name and type are required." });
  }

  const query = `SELECT MAX(CAST(account_code AS INTEGER)) as max_code FROM chart_of_accounts `;

  db.get(query, (err, row) => {
    if (err) {
      console.error(err);
      return res
        .status(500)
        .json({ error: "Failed to calculate account code." });
    }

    const maxCode = row?.max_code || 0;
    const nextCode = maxCode + 1;

    const insertQuery = `
        INSERT INTO chart_of_accounts (account_code, account_name, account_type, balance, parent_account_id)
        VALUES (?, ?, ?, ?, ?)
      `;

    db.run(
      insertQuery,
      [
        nextCode.toString(),
        account_name,
        account_type,
        balance || 0,
        parent_account_id || null,
      ],
      function (err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: "Failed to add account." });
        }

        const newAccountId = this.lastID;

        // Log audit trail for account creation
        logAuditTrail(req, db, "chart_of_accounts", newAccountId, "insert", {
          account_code: nextCode.toString(),
          account_name,
          account_type,
          balance: balance || 0,
          parent_account_id: parent_account_id || null,
        });

        if (balance !== 0) {
          const referenceNumber = `OB-${Date.now()}`;
          // const date = new Date().toISOString().split("T")[0];
          const description = `Opening balance for ${account_name}`;

          const journalEntryQuery = `
              INSERT INTO journal_entries (reference_number, date, description, status)
              VALUES (?, ?, ?, 'posted')
            `;

          db.run(
            journalEntryQuery,
            [referenceNumber, date, description],
            function (err) {
              if (err) {
                console.error(err);
                return res
                  .status(500)
                  .json({ error: "Failed to log journal entry." });
              }

              const journalEntryId = this.lastID;
              const journalLineQuery = `
                INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
                VALUES (?, ?, ?, ?)
              `;

              const amount = Math.abs(balance);
              let debit = 0;
              let credit = 0;

              if (balance_type === "debit") {
                debit = amount;
              } else if (balance_type === "credit") {
                credit = amount;
              } else {
                return res.status(400).json({
                  error: "Invalid balance_type. Must be 'debit' or 'credit'.",
                });
              }

              db.run(
                journalLineQuery,
                [journalEntryId, newAccountId, debit, credit],
                (err) => {
                  if (err) {
                    console.error(err);
                    return res
                      .status(500)
                      .json({ error: "Failed to log journal entry line." });
                  }

                  // Update the chart_of_accounts table with the opening balance journal entry ID
                  const updateAccountQuery = `
                  UPDATE chart_of_accounts SET opening_balance_journal_entry_id = ? WHERE id = ?
                `;
                  db.run(
                    updateAccountQuery,
                    [journalEntryId, newAccountId],
                    (err) => {
                      if (err) {
                        console.error(err);
                        return res.status(500).json({
                          error:
                            "Failed to update account with journal entry ID.",
                        });
                      }

                      // Log audit trail for journal entry
                      logAuditTrail(
                        req,
                        db,
                        "journal_entries",
                        journalEntryId,
                        "insert",
                        {
                          reference_number: referenceNumber,
                          date,
                          description,
                          status: "posted",
                        }
                      );

                      // Log audit trail for journal entry line
                      logAuditTrail(
                        req,
                        db,
                        "journal_entry_lines",
                        journalEntryId,
                        "insert",
                        {
                          account_id: newAccountId,
                          debit,
                          credit,
                        }
                      );

                      res.status(201).json({
                        id: newAccountId,
                        account_code: nextCode.toString(),
                        account_name,
                        account_type,
                        balance: balance || 0,
                        parent_account_id: parent_account_id || null,
                        opening_balance_journal_entry_id: journalEntryId,
                      });
                    }
                  );
                }
              );
            }
          );
        } else {
          res.status(201).json({
            id: newAccountId,
            account_code: nextCode.toString(),
            account_name,
            account_type,
            balance: balance || 0,
            parent_account_id: parent_account_id || null,
          });
        }
      }
    );
  });
});

router.delete("/accounts/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id; // Get user ID from authenticateUser middleware

  // Retrieve account details before deletion for audit logging
  const selectQuery = "SELECT * FROM chart_of_accounts WHERE id = ?";

  db.get(selectQuery, [id], (err, account) => {
    if (err) {
      console.error(err);
      return res
        .status(500)
        .json({ error: "Failed to retrieve account details." });
    }

    if (!account) {
      return res.status(404).json({ error: "Account not found." });
    }

    // Proceed to delete the account
    db.run("DELETE FROM chart_of_accounts WHERE id = ?", [id], function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to delete account." });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: "Account not found." });
      }

      // Log audit trail for account deletion
      logAuditTrail(req, db, "chart_of_accounts", id, "delete", {
        account_code: account.account_code,
        account_name: account.account_name,
        account_type: account.account_type,
        balance: account.balance,
        parent_account_id: account.parent_account_id,
      });

      res.status(204).end();
    });
  });
});

router.put("/accounts/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { account_name, account_type, balance, balance_type, parent_account_id } = req.body;

  // Prepare the update fields dynamically
  const updates = [];
  const params = [];

  if (account_name !== undefined) {
    updates.push("account_name = ?");
    params.push(account_name);
  }

  if (account_type !== undefined) {
    updates.push("account_type = ?");
    params.push(account_type);
  }

  if (parent_account_id !== undefined) {
    updates.push("parent_account_id = ?");
    params.push(parent_account_id);
  }

  if (balance !== undefined) {
    updates.push("balance = ?");
    params.push(balance);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields provided to update." });
  }

  const updateQuery = `UPDATE chart_of_accounts SET ${updates.join(
    ", "
  )} WHERE id = ?`;
  params.push(id);

  // Fetch the original account data before the update
  db.get(
    "SELECT * FROM chart_of_accounts WHERE id = ?",
    [id],
    (err, account) => {
      if (err || !account) {
        console.error(err);
        return res.status(500).json({
          error: "Account not found or failed to fetch account details.",
        });
      }

      const originalBalance = account.balance;

      // Perform the update
      db.run(updateQuery, params, function (err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: "Failed to update account." });
        }

        // If balance is updated, create or update a journal entry
        if (balance !== undefined && balance !== originalBalance) {
          const journalEntry = {
            reference_number: `OPENBAL-${id}-${Date.now()}`,
            date: new Date().toISOString(),
            description: `Opening balance for account ID ${id}`,
            status: "posted",
          };

          const amount = Math.abs(balance);
          let debit = 0;
          let credit = 0;

          if (balance_type === "debit") {
            debit = amount;
          } else if (balance_type === "credit") {
            credit = amount;
          } else {
            return res.status(400).json({
              error: "Invalid balance_type. Must be 'debit' or 'credit'.",
            });
          }

          // Check if there's an existing journal entry for the opening balance
          db.get(
            "SELECT opening_balance_journal_entry_id FROM chart_of_accounts WHERE id = ?",
            [id],
            (err, result) => {
              if (err) {
                console.error("Failed to fetch existing journal entry:", err);
                return res
                  .status(500)
                  .json({ error: "Failed to fetch existing journal entry." });
              }

              const existingJournalEntryId =
                result?.opening_balance_journal_entry_id;

              if (existingJournalEntryId) {
                // Update the existing journal entry lines
                db.run(
                  `UPDATE journal_entry_lines SET debit = ?, credit = ? WHERE journal_entry_id = ? AND account_id = ?`,
                  [debit, credit, existingJournalEntryId, id],
                  (err) => {
                    if (err) {
                      console.error(
                        "Failed to update journal entry line:",
                        err
                      );
                      return res.status(500).json({
                        error: "Failed to update journal entry line.",
                      });
                    }

                    updateParentBalance(account.parent_account_id, (err) => {
                      if (err) {
                        console.error(
                          "Failed to update parent account balance:",
                          err
                        );
                        return res.status(500).json({
                          error: "Failed to update parent account balance.",
                        });
                      }

                      res.json({
                        id,
                        ...(account_name !== undefined && { account_name }),
                        ...(account_type !== undefined && { account_type }),
                        ...(balance !== undefined && { balance }),
                      });
                    });
                  }
                );
              } else {
                // Create a new journal entry and journal entry lines
                db.run(
                  `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, ?)`,
                  [
                    journalEntry.reference_number,
                    journalEntry.date,
                    journalEntry.description,
                    journalEntry.status,
                  ],
                  function (err) {
                    if (err) {
                      console.error("Failed to create journal entry:", err);
                      return res
                        .status(500)
                        .json({ error: "Failed to create journal entry." });
                    }

                    const journalEntryId = this.lastID;

                    // Insert the journal entry line
                    db.run(
                      `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                      [journalEntryId, id, debit, credit],
                      (err) => {
                        if (err) {
                          console.error(
                            "Failed to create journal entry line:",
                            err
                          );
                          return res.status(500).json({
                            error: "Failed to create journal entry line.",
                          });
                        }

                        // Save the journal entry ID in the account record
                        db.run(
                          `UPDATE chart_of_accounts SET opening_balance_journal_entry_id = ? WHERE id = ?`,
                          [journalEntryId, id],
                          (err) => {
                            if (err) {
                              console.error(
                                "Failed to update account with journal entry ID:",
                                err
                              );
                              return res.status(500).json({
                                error:
                                  "Failed to link journal entry to account.",
                              });
                            }

                            // Update parent balances
                            updateParentBalance(
                              account.parent_account_id,
                              (err) => {
                                if (err) {
                                  console.error(
                                    "Failed to update parent account balance:",
                                    err
                                  );
                                  return res.status(500).json({
                                    error:
                                      "Failed to update parent account balance.",
                                  });
                                }

                                res.json({
                                  id,
                                  ...(account_name !== undefined && {
                                    account_name,
                                  }),
                                  ...(account_type !== undefined && {
                                    account_type,
                                  }),
                                  ...(balance !== undefined && { balance }),
                                  journal_entry: journalEntry,
                                });
                              }
                            );
                          }
                        );
                      }
                    );
                  }
                );
              }
            }
          );
        } else {
          // If no balance update, handle parent updates directly
          if (parent_account_id !== undefined) {
            updateParentBalance(parent_account_id, (err) => {
              if (err) {
                console.error("Failed to update parent account balance:", err);
                return res
                  .status(500)
                  .json({ error: "Failed to update parent account balance." });
              }
              res.json({
                id,
                ...(account_name !== undefined && { account_name }),
                ...(account_type !== undefined && { account_type }),
                ...(balance !== undefined && { balance }),
              });
            });
          } else {
            res.json({
              id,
              ...(account_name !== undefined && { account_name }),
              ...(account_type !== undefined && { account_type }),
              ...(balance !== undefined && { balance }),
            });
          }
        }
      });

      // Construct changes object for logging
      const changes = {};
      if (account_name !== undefined && account_name !== account.account_name) {
        changes.account_name = { old: account.account_name, new: account_name };
      }
      if (account_type !== undefined && account_type !== account.account_type) {
        changes.account_type = { old: account.account_type, new: account_type };
      }
      if (balance !== undefined && balance !== originalBalance) {
        changes.balance = { old: originalBalance, new: balance };
      }
      if (
        parent_account_id !== undefined &&
        parent_account_id !== account.parent_account_id
      ) {
        changes.parent_account_id = {
          old: account.parent_account_id,
          new: parent_account_id,
        };
      }

      // Log audit trail if there are changes
      if (Object.keys(changes).length > 0) {
        logAuditTrail(req, db, "chart_of_accounts", id, "update", changes);
      }
    }
  );
});



const updateParentBalance = (parentId, callback) => {
  if (!parentId) return callback(null); // Stop if there's no parent

  db.all(
    "SELECT SUM(balance) AS total_balance FROM chart_of_accounts WHERE parent_account_id = ?",
    [parentId],
    (err, result) => {
      if (err) return callback(err);

      const totalBalance = result[0]?.total_balance || 0;

      db.run(
        "UPDATE chart_of_accounts SET balance = ? WHERE id = ?",
        [totalBalance, parentId],
        (err) => {
          if (err) return callback(err);

          // Recursively update the grandparent if exists
          db.get(
            "SELECT parent_account_id FROM chart_of_accounts WHERE id = ?",
            [parentId],
            (err, parent) => {
              if (err) return callback(err);

              if (parent?.parent_account_id) {
                updateParentBalance(parent.parent_account_id, callback);
              } else {
                callback(null); // No more parents to update
              }
            }
          );
        }
      );
    }
  );
};

// Function to update parent after removing a child
const removeChildFromParent = (childId, callback) => {
  db.get(
    "SELECT parent_account_id FROM chart_of_accounts WHERE id = ?",
    [childId],
    (err, child) => {
      if (err) return callback(err);
      if (!child?.parent_account_id) return callback(null); // No parent, nothing to update

      const oldParentId = child.parent_account_id;

      // Remove the child-parent link
      db.run(
        "UPDATE chart_of_accounts SET parent_account_id = NULL WHERE id = ?",
        [childId],
        (err) => {
          if (err) return callback(err);

          // Recalculate the old parent's balance
          updateParentBalance(oldParentId, callback);
        }
      );
    }
  );
};

// ===================== Draft Endpoints =====================

// Get all drafts
router.get("/drafts", authenticateUser, (req, res) => {
  db.all("SELECT * FROM drafts ORDER BY date DESC", (err, rows) => {
    if (err) {
      console.error("Error fetching drafts:", err.message);
      res.status(500).send("Error fetching drafts");
    } else {
      res.json(rows);
    }
  });
});

// Get a specific draft by ID
router.get("/drafts/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM drafts WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error("Error fetching draft:", err.message);
      res.status(500).send("Error fetching draft");
    } else if (!row) {
      res.status(404).send("Draft not found");
    } else {
      res.json(row);
    }
  });
});
// Add a new draft
router.post("/drafts", authenticateUser, (req, res) => {
  const { referenceNumber, details, date, status } = req.body;
  const userId = req.user.id; // Get user ID from authenticateUser middleware

  if (!referenceNumber || !details || !date) {
    return res
      .status(400)
      .send("Missing required fields: referenceNumber, details, or date");
  }

  const detailsJSON = JSON.stringify(details);

  db.run(
    `INSERT INTO drafts (reference_number, details, date, status) VALUES (?, ?, ?, ?)`,
    [referenceNumber, detailsJSON, date, status || "pending"],
    function (err) {
      if (err) {
        console.error("Error adding draft:", err.message);
        res.status(500).send("Error adding draft");
      } else {
        const newDraftId = this.lastID;

        // Log audit trail for draft creation
        logAuditTrail(req, db, "drafts", newDraftId, "insert", {
          reference_number: referenceNumber,
          details,
          date,
          status: status || "pending",
        });

        res.status(201).json({
          id: newDraftId,
          referenceNumber,
          details,
          date,
          status: status || "pending",
        });
      }
    }
  );
});

// Update a draft
router.put("/drafts/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { referenceNumber, details, date, status } = req.body;

  const fields = [];
  const values = [];
  const changes = {};

  if (referenceNumber) {
    fields.push("reference_number = ?");
    values.push(referenceNumber);
    changes.reference_number = referenceNumber;
  }
  if (details) {
    fields.push("details = ?");
    values.push(JSON.stringify(details));
    changes.details = details;
  }
  if (date) {
    fields.push("date = ?");
    values.push(date);
    changes.date = date;
  }
  if (status) {
    fields.push("status = ?");
    values.push(status);
    changes.status = status;
  }

  if (fields.length === 0) {
    return res.status(400).send("No fields to update");
  }

  values.push(id);

  const query = `UPDATE drafts SET ${fields.join(", ")} WHERE id = ?`;

  db.run(query, values, function (err) {
    if (err) {
      console.error("Error updating draft:", err.message);
      res.status(500).send("Error updating draft");
    } else if (this.changes === 0) {
      res.status(404).send("Draft not found");
    } else {
      // Log audit trail for draft update
      logAuditTrail(req, db, "drafts", id, "update", changes);

      res.json({ id, referenceNumber, details, date, status });
    }
  });
});

// Delete a draft
router.delete("/drafts/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  db.get("SELECT * FROM drafts WHERE id = ?", [id], (err, draft) => {
    if (err) {
      console.error("Error finding draft:", err.message);
      return res.status(500).send("Error deleting draft");
    }

    if (!draft) {
      return res.status(404).send("Draft not found");
    }

    db.run("DELETE FROM drafts WHERE id = ?", [id], function (err) {
      if (err) {
        console.error("Error deleting draft:", err.message);
        res.status(500).send("Error deleting draft");
      } else {
        // Log audit trail for draft deletion
        logAuditTrail(req, db, "drafts", id, "delete", {
          reference_number: draft.reference_number,
          details: JSON.parse(draft.details),
          date: draft.date,
          status: draft.status,
        });

        res.status(204).send();
      }
    });
  });
});

// ===================== Invoice Endpoints =====================
// Create invoice (POST request)
router.post("/invoices", authenticateUser, (req, res) => {
  const {
    reference_number,
    customer_id,
    total_amount,
    amount_paid = 0,
    due_date = null,
    status = "unpaid",
  } = req.body;

  const userId = req.user.id; // Get user ID from authenticateUser middleware

  const sql = `
      INSERT INTO invoices (reference_number, customer_id, total_amount, amount_paid, due_date, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

  db.run(
    sql,
    [
      reference_number,
      customer_id,
      total_amount,
      amount_paid,
      due_date,
      status,
    ],
    function (err) {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        const newInvoiceId = this.lastID;

        // Log audit trail for invoice creation
        logAuditTrail(req, db, "invoices", newInvoiceId, "insert", {
          reference_number,
          customer_id,
          total_amount,
          amount_paid,
          due_date,
          status,
        });

        res.status(201).json({ id: newInvoiceId });
      }
    }
  );
});

// Get all invoices (GET request)
router.get("/invoices", authenticateUser, (req, res) => {
  const sql = "SELECT * FROM invoices";

  db.all(sql, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.status(200).json(rows);
    }
  });
});

// Get a single invoice by reference_number (GET request)
router.get("/invoices/:reference_number", authenticateUser, (req, res) => {
  const { reference_number } = req.params;

  const sql = "SELECT * FROM invoices WHERE reference_number = ?";

  db.get(sql, [reference_number], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else if (!row) {
      res.status(404).json({ message: "Invoice not found" });
    } else {
      res.status(200).json(row);
    }
  });
});
// Get invoices by customer and status (unpaid or partial)
router.get("/invoices/customer/:customer_id", authenticateUser, (req, res) => {
  const { customer_id } = req.params;
  const sql =
    'SELECT * FROM invoices WHERE customer_id = ? AND (status = "unpaid" OR status = "partial")';

  db.all(sql, [customer_id], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.status(200).json(rows);
    }
  });
});
// Update an invoice (PUT request)
router.put("/invoices/:reference_number", authenticateUser, (req, res) => {
  const { reference_number } = req.params;
  const { total_amount, amount_paid, due_date, status } = req.body;
  const userId = req.user.id; // Get user ID from authenticateUser middleware

  // Fetch existing invoice before updating
  const fetchInvoiceSQL = "SELECT * FROM invoices WHERE reference_number = ?";

  db.get(fetchInvoiceSQL, [reference_number], (err, existingInvoice) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    } else if (!existingInvoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const sql = `
        UPDATE invoices
        SET total_amount = ?, amount_paid = ?, due_date = ?, status = ?
        WHERE reference_number = ?
      `;

    db.run(
      sql,
      [total_amount, amount_paid, due_date, status, reference_number],
      function (err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        } else if (this.changes === 0) {
          return res
            .status(404)
            .json({ message: "No changes made to the invoice" });
        }

        // Log audit trail for invoice update
        logAuditTrail(req, db, "invoices", reference_number, "update", {
          previous: existingInvoice,
          updated: { total_amount, amount_paid, due_date, status },
        });

        res.status(200).json({ message: "Invoice updated successfully" });
      }
    );
  });
});

// Delete an invoice (DELETE request)
router.delete("/invoices/:reference_number", authenticateUser, (req, res) => {
  const { reference_number } = req.params;
  const userId = req.user.id; // Get user ID from authenticateUser middleware

  // Fetch invoice before deleting for audit logging
  const fetchInvoiceSQL = "SELECT * FROM invoices WHERE reference_number = ?";

  db.get(fetchInvoiceSQL, [reference_number], (err, existingInvoice) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    } else if (!existingInvoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const sql = "DELETE FROM invoices WHERE reference_number = ?";

    db.run(sql, [reference_number], function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      } else if (this.changes === 0) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      // Log audit trail for invoice deletion
      logAuditTrail(req, db, "invoices", reference_number, "delete", {
        deleted_invoice: existingInvoice,
      });

      res.status(200).json({ message: "Invoice deleted successfully" });
    });
  });
});

// ===================== Supplier Payments Endpoints =====================
// ===================== Supplier Payments Endpoints =====================
router.post("/supplier_payments", authenticateUser, (req, res) => {
  const {
    supplier_id,
    purchase_order_id,
    amount_paid,
    payment_method,
    payment_reference,
  } = req.body;

  const userId = req.user.id; // Get user ID from authenticateUser middleware

  if (!supplier_id || !amount_paid || !payment_method) {
    return res
      .status(400)
      .send("Supplier ID, amount paid, and payment method are required.");
  }

  // Step 1: Check the balance of the selected payment method's account
  const getAccountBalanceQuery = `
      SELECT c.id AS account_id, c.balance 
      FROM payment_methods p 
      JOIN chart_of_accounts c ON p.account_id = c.id 
      WHERE p.name = ? AND p.is_active = 1
    `;

  db.get(getAccountBalanceQuery, [payment_method], (err, account) => {
    if (err) {
      console.error("Error fetching account balance:", err.message);
      return res.status(500).send("Failed to fetch account balance.");
    }

    if (!account) {
      return res.status(400).send("Invalid or inactive payment method.");
    }

    if (account.balance < amount_paid) {
      return res
        .status(400)
        .send(
          `Insufficient balance in the selected payment method (${payment_method}). Available balance: ${account.balance}`
        );
    }

    // Step 2: Insert the supplier payment into the database
    const insertPaymentQuery = `
        INSERT INTO supplier_payments (supplier_id, purchase_order_id, amount_paid, payment_method, payment_reference)
        VALUES (?, ?, ?, ?, ?)
      `;
    const params = [
      supplier_id,
      purchase_order_id || null,
      amount_paid,
      payment_method || null,
      payment_reference || null,
    ];

    db.run(insertPaymentQuery, params, function (err) {
      if (err) {
        console.error("Error adding supplier payment:", err.message);
        return res.status(500).send("Failed to add supplier payment.");
      }

      const paymentId = this.lastID;

      // ✅ Step 3: Log audit trail for new supplier payment
      logAuditTrail(req, db, "supplier_payments", paymentId, "insert", {
        supplier_id,
        purchase_order_id,
        amount_paid,
        payment_method,
        payment_reference,
      });

      // Step 4: Update the purchase order's payment status if applicable
      if (purchase_order_id) {
        const updatePurchaseOrderQuery = `
            UPDATE purchase_orders
            SET payment_status = CASE 
              WHEN (SELECT SUM(amount_paid) FROM supplier_payments WHERE purchase_order_id = ?) >= total_amount 
              THEN 'paid' 
              ELSE 'partial' 
            END
            WHERE id = ?
          `;

        db.run(
          updatePurchaseOrderQuery,
          [purchase_order_id, purchase_order_id],
          function (err) {
            if (err) {
              console.error("Error updating purchase order:", err.message);
            } else if (this.changes > 0) {
              // ✅ Step 5: Log audit trail for purchase order payment update
              logAuditTrail(
                req,
                db,
                "purchase_orders",
                purchase_order_id,
                "update",
                {
                  updated_payment_status:
                    this.changes > 0 ? "Payment status updated" : "No changes",
                }
              );
            }
          }
        );
      }

      // Step 6: Send success response
      res.status(201).send({ id: paymentId });
    });
  });
});

// READ: Get all supplier payments
router.get("/supplier_payments", authenticateUser, (req, res) => {
  const query = "SELECT * FROM supplier_payments";

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error("Error retrieving supplier payments:", err.message);
      return res.status(500).send("Failed to retrieve supplier payments.");
    }
    res.status(200).json(rows);
  });
});
// READ: Get a specific supplier payment by ID
router.get("/supplier_payments/:id", authenticateUser, (req, res) => {
  const query = "SELECT * FROM supplier_payments WHERE id = ?";
  const params = [req.params.id];

  db.get(query, params, (err, row) => {
    if (err) {
      console.error("Error retrieving supplier payment:", err.message);
      return res.status(500).send("Failed to retrieve supplier payment.");
    }
    if (!row) {
      return res.status(404).send("Supplier payment not found.");
    }
    res.status(200).json(row);
  });
});

// UPDATE: Update a supplier payment
router.put("/supplier_payments/:id", authenticateUser, (req, res) => {
  const {
    supplier_id,
    purchase_order_id,
    amount_paid,
    payment_method,
    payment_reference,
  } = req.body;

  const paymentId = req.params.id;
  const userId = req.user.id; // Get user ID from authenticateUser middleware

  // Fetch existing payment details before update (for logging)
  db.get(
    "SELECT * FROM supplier_payments WHERE id = ?",
    [paymentId],
    (err, oldPayment) => {
      if (err) {
        console.error("Error fetching supplier payment:", err.message);
        return res.status(500).send("Failed to fetch supplier payment.");
      }
      if (!oldPayment) {
        return res.status(404).send("Supplier payment not found.");
      }

      // Update supplier payment
      const query = `
        UPDATE supplier_payments
        SET supplier_id = ?, purchase_order_id = ?, amount_paid = ?, payment_method = ?, payment_reference = ?
        WHERE id = ?
      `;
      const params = [
        supplier_id,
        purchase_order_id,
        amount_paid,
        payment_method,
        payment_reference,
        paymentId,
      ];

      db.run(query, params, function (err) {
        if (err) {
          console.error("Error updating supplier payment:", err.message);
          return res.status(500).send("Failed to update supplier payment.");
        }
        if (this.changes === 0) {
          return res.status(404).send("Supplier payment not found.");
        }

        // ✅ Log audit trail for update
        logAuditTrail(req, db, "supplier_payments", paymentId, "update", {
          oldData: oldPayment,
          newData: {
            supplier_id,
            purchase_order_id,
            amount_paid,
            payment_method,
            payment_reference,
          },
        });

        res.status(200).send("Supplier payment updated successfully.");
      });
    }
  );
});

// DELETE: Delete a supplier payment
router.delete("/supplier_payments/:id", authenticateUser, (req, res) => {
  const paymentId = req.params.id;
  const userId = req.user.id;

  // Fetch existing payment details before deletion (for logging)
  db.get(
    "SELECT * FROM supplier_payments WHERE id = ?",
    [paymentId],
    (err, oldPayment) => {
      if (err) {
        console.error("Error fetching supplier payment:", err.message);
        return res.status(500).send("Failed to fetch supplier payment.");
      }
      if (!oldPayment) {
        return res.status(404).send("Supplier payment not found.");
      }

      // Delete supplier payment
      const query = "DELETE FROM supplier_payments WHERE id = ?";
      db.run(query, [paymentId], function (err) {
        if (err) {
          console.error("Error deleting supplier payment:", err.message);
          return res.status(500).send("Failed to delete supplier payment.");
        }
        if (this.changes === 0) {
          return res.status(404).send("Supplier payment not found.");
        }

        // ✅ Log audit trail for delete
        logAuditTrail(req, db, "supplier_payments", paymentId, "delete", {
          deletedData: oldPayment,
        });

        res.status(200).send("Supplier payment deleted successfully.");
      });
    }
  );
});

// ===================== Payments Methods Endpoints =====================
router.post("/payment-methods", authenticateUser, (req, res) => {
  const { name, account_id, description } = req.body;

  if (!name || !account_id) {
    return res.status(400).send("Name and account_id are required.");
  }

  const query = `
      INSERT INTO payment_methods (name, account_id, description)
      VALUES (?, ?, ?)
    `;
  db.run(query, [name, account_id, description || null], function (err) {
    if (err) {
      console.error("Error adding payment method:", err.message);
      return res.status(500).send("Failed to add payment method.");
    }
    res
      .status(201)
      .send({ id: this.lastID, message: "Payment method created." });
  });
});

router.get("/payment-methods", authenticateUser, (req, res) => {
  const query = `
      SELECT 
        pm.id, 
        pm.name, 
        pm.description, 
        pm.is_active, 
        pm.created_at, 
        pm.updated_at, 
        ca.account_name AS linked_account 
      FROM payment_methods pm
      JOIN chart_of_accounts ca ON pm.account_id = ca.id
    `;
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error("Error retrieving payment methods:", err.message);
      return res.status(500).send("Failed to retrieve payment methods.");
    }
    res.status(200).json(rows);
  });
});
router.get("/payment-methods/:id", authenticateUser, (req, res) => {
  const query = `
      SELECT 
        pm.id, 
        pm.name, 
        pm.description, 
        pm.is_active, 
        pm.created_at, 
        pm.updated_at, 
        ca.account_name AS linked_account 
      FROM payment_methods pm
      JOIN chart_of_accounts ca ON pm.account_id = ca.id
      WHERE pm.id = ?
    `;
  db.get(query, [req.params.id], (err, row) => {
    if (err) {
      console.error("Error retrieving payment method:", err.message);
      return res.status(500).send("Failed to retrieve payment method.");
    }
    if (!row) return res.status(404).send("Payment method not found.");
    res.status(200).json(row);
  });
});
router.put("/payment-methods/:id", authenticateUser, (req, res) => {
  const { name, account_id, description, is_active } = req.body;

  if (!name && !account_id && !description && is_active == null) {
    return res.status(400).send("Nothing to update.");
  }

  const query = `
      UPDATE payment_methods
      SET 
        name = COALESCE(?, name),
        account_id = COALESCE(?, account_id),
        description = COALESCE(?, description),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
  db.run(
    query,
    [name, account_id, description, is_active, req.params.id],
    function (err) {
      if (err) {
        console.error("Error updating payment method:", err.message);
        return res.status(500).send("Failed to update payment method.");
      }
      if (this.changes === 0)
        return res.status(404).send("Payment method not found.");
      res.status(200).send("Payment method updated.");
    }
  );
});
router.delete("/payment-methods/:id", authenticateUser, (req, res) => {
  const query = "DELETE FROM payment_methods WHERE id = ?";
  db.run(query, [req.params.id], function (err) {
    if (err) {
      console.error("Error deleting payment method:", err.message);
      return res.status(500).send("Failed to delete payment method.");
    }
    if (this.changes === 0)
      return res.status(404).send("Payment method not found.");
    res.status(200).send("Payment method deleted.");
  });
});

// ===================== Payments Endpoints =====================
router.post("/payments", authenticateUser, (req, res) => {
  const {
    customerId,
    reference_number,
    payment_date,
    amount_paid,
    payment_method,
    payment_reference,
  } = req.body;

  if (!reference_number || !amount_paid) {
    return res
      .status(400)
      .send("Reference number and amount paid are required.");
  }

  // Insert the payment
  const paymentQuery = `
      INSERT INTO payments (customer_id,reference_number, payment_date, amount_paid, payment_method, payment_reference)
      VALUES (?,?, ?, ?, ?, ?)
    `;
  const paymentParams = [
    customerId,
    reference_number,
    payment_date || new Date().toISOString(),
    amount_paid,
    payment_method || null,
    payment_reference || null,
  ];

  db.run(paymentQuery, paymentParams, function (err) {
    if (err) {
      console.error("Error adding payment:", err.message);
      return res.status(500).send("Failed to add payment.");
    }

    const paymentId = this.lastID;

    // Insert into journal_entries
    const journalEntryQuery = `
        INSERT INTO journal_entries (reference_number, date, description, status)
        VALUES (?, ?, ?, 'posted')
      `;
    const journalEntryParams = [
      reference_number,
      payment_date || new Date().toISOString(),
      `Payment received (${payment_method || "unknown"})`,
    ];

    db.run(journalEntryQuery, journalEntryParams, function (err) {
      if (err) {
        console.error("Error adding journal entry:", err.message);
        return res.status(500).send("Failed to add journal entry.");
      }

      const journalEntryId = this.lastID;

      // Insert into journal_entry_lines
      const journalEntryLinesQuery = `
          INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
          VALUES (?, ?, ?, ?), (?, ?, ?, ?)
        `;
      const cashOrBankAccountId =
        payment_method === "cash" ? 1 : payment_method === "credit" ? 2 : null;
      const journalEntryLinesParams = [
        journalEntryId,
        cashOrBankAccountId, // Cash or Bank Account
        parseFloat(amount_paid), // Debit
        0, // No credit

        journalEntryId,
        4, // Accounts Receivable
        0, // No debit
        parseFloat(amount_paid), // Credit
      ];

      db.run(journalEntryLinesQuery, journalEntryLinesParams, function (err) {
        if (err) {
          console.error("Error adding journal entry lines:", err.message);
          return res.status(500).send("Failed to add journal entry lines.");
        }

        // Insert into audit_trails
        const auditTrailQuery = `
            INSERT INTO audit_trails (user_id, table_name, record_id, action, changes)
            VALUES (?, ?, ?, ?, ?)
          `;
        const auditTrailParams = [
          1, // Assuming `req.user` contains the logged-in user's details
          "payments",
          paymentId,
          "insert",
          JSON.stringify({
            customerId,
            reference_number,
            payment_date,
            amount_paid,
            payment_method,
            payment_reference,
          }),
        ];

        db.run(auditTrailQuery, auditTrailParams, function (err) {
          if (err) {
            console.error("Error adding to audit trail:", err.message);
            return res.status(500).send("Failed to record audit trail.");
          }

          // Successfully processed payment
          res.status(201).send({ id: paymentId });
        });
      });
    });
  });
});

// READ: Get all payments
router.get("/payments", authenticateUser, (req, res) => {
  const query = "SELECT * FROM payments";

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error("Error retrieving payments:", err.message);
      return res.status(500).send("Failed to retrieve payments.");
    }
    res.status(200).json(rows);
  });
});

// READ: Get a specific payment by ID
router.get("/payments/:id", authenticateUser, (req, res) => {
  const query = "SELECT * FROM payments WHERE id = ?";
  const params = [req.params.id];

  db.get(query, params, (err, row) => {
    if (err) {
      console.error("Error retrieving payment:", err.message);
      return res.status(500).send("Failed to retrieve payment.");
    }
    if (!row) {
      return res.status(404).send("Payment not found.");
    }
    res.status(200).json(row);
  });
});

// UPDATE: Update a payment
router.put("/payments/:id", authenticateUser, (req, res) => {
  const {
    reference_number,
    payment_date,
    amount_paid,
    payment_method,
    payment_reference,
  } = req.body;

  const query = `
      UPDATE payments
      SET reference_number = ?, payment_date = ?, amount_paid = ?, payment_method = ?, payment_reference = ?
      WHERE id = ?
    `;
  const params = [
    reference_number,
    payment_date,
    amount_paid,
    payment_method,
    payment_reference,
    req.params.id,
  ];

  db.run(query, params, function (err) {
    if (err) {
      console.error("Error updating payment:", err.message);
      return res.status(500).send("Failed to update payment.");
    }
    if (this.changes === 0) {
      return res.status(404).send("Payment not found.");
    }
    res.status(200).send("Payment updated successfully.");
  });
});

// DELETE: Delete a payment
router.delete("/payments/:id", authenticateUser, (req, res) => {
  const query = "DELETE FROM payments WHERE id = ?";
  const params = [req.params.id];

  db.run(query, params, function (err) {
    if (err) {
      console.error("Error deleting payment:", err.message);
      return res.status(500).send("Failed to delete payment.");
    }
    if (this.changes === 0) {
      return res.status(404).send("Payment not found.");
    }
    res.status(200).send("Payment deleted successfully.");
  });
});

// ===================== Sales Endpoints =====================
router.post("/sales", authenticateUser, async (req, res) => {
  const salesData = Array.isArray(req.body) ? req.body : [req.body];

  const dbPromise = new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION", (err) => {
        if (err) return reject(new Error("Failed to start transaction"));

        let errorOccurred = false;
        let totalCartPrice = 0;
        const saleResponses = [];
        const reference_number = salesData[0].reference_number;
        const customer_id = salesData[0].customer_id;
        const payment_method = salesData[0].payment_method;

        const processSalePromises = salesData.map(
          ({
            product_id,
            quantity,
            selling_price,
            taxes, // Now an array of tax IDs
            discount_type,
            discount_amount,
            description,
          }) => {
            return new Promise((resolveSale, rejectSale) => {
              db.get(
                "SELECT * FROM inventory WHERE product_id = ?",
                [product_id],
                (err, inventory) => {
                  if (err || !inventory) {
                    errorOccurred = true;
                    console.error(err ? err.message : "Inventory not found");
                    return rejectSale("Inventory not found");
                  }

                  if (inventory.quantity_in_stock < quantity) {
                    errorOccurred = true;
                    console.error(
                      "Insufficient stock for product ID:",
                      product_id
                    );
                    return rejectSale("Insufficient stock");
                  }

                  const itemSubtotal = selling_price * quantity;
                  const discount =
                    discount_type === "percentage"
                      ? (itemSubtotal * discount_amount) / 100
                      : discount_amount;

                  const totalAfterDiscount = itemSubtotal - discount;
                  let totalTaxAmount = 0;

                  // Calculate total tax amount
                  const taxPromises = taxes.map((tax_id) => {
                    return new Promise((resolveTax, rejectTax) => {
                      db.get(
                        "SELECT * FROM taxes WHERE id = ?",
                        [tax_id],
                        (err, taxData) => {
                          if (err || !taxData) {
                            console.error(err ? err.message : "Tax not found");
                            return rejectTax("Tax not found");
                          }

                          let taxAmount = 0;

                          if (taxData.tax_type === "exclusive") {
                            taxAmount =
                              (totalAfterDiscount * taxData.tax_rate) / 100;
                          } else if (taxData.tax_type === "inclusive") {
                            taxAmount =
                              totalAfterDiscount -
                              totalAfterDiscount / (1 + taxData.tax_rate / 100);
                          }

                          totalTaxAmount += taxAmount;
                          resolveTax({ tax_id, taxAmount });
                        }
                      );
                    });
                  });

                  Promise.all(taxPromises)
                    .then((calculatedTaxes) => {
                      const total_price = totalAfterDiscount + totalTaxAmount;
                      totalCartPrice += total_price;

                      db.run(
                        `INSERT INTO sales (customer_id, product_id, payment_method, reference_number, quantity, total_price, date, selling_price, discount_type, discount_amount, description) 
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                          customer_id,
                          product_id,
                          payment_method,
                          reference_number,
                          quantity,
                          total_price,
                          new Date().toISOString(),
                          selling_price,
                          discount_type,
                          discount_amount,
                          description,
                        ],
                        function (err) {
                          if (err) {
                            errorOccurred = true;
                            console.error("Error: ", err.message);
                            return rejectSale("Error inserting sale items");
                          }

                          const sale_id = this.lastID;

                          // Insert tax details into sales_taxes and sale_tax_amounts
                          const taxInsertPromises = calculatedTaxes.map(
                            ({ tax_id, taxAmount }) => {
                              return new Promise(
                                (resolveInsert, rejectInsert) => {
                                  db.run(
                                    "INSERT INTO sales_taxes (sale_id, tax_id) VALUES (?, ?)",
                                    [sale_id, tax_id],
                                    function (err) {
                                      if (err) {
                                        errorOccurred = true;
                                        console.error(
                                          "Error inserting tax: ",
                                          err.message
                                        );
                                        return rejectInsert(
                                          "Error inserting sales_taxes"
                                        );
                                      }

                                      const sale_tax_id = this.lastID;
                                      db.run(
                                        "INSERT INTO sale_tax_amounts (sale_tax_id, tax_amount) VALUES (?, ?)",
                                        [sale_tax_id, taxAmount],
                                        (err) => {
                                          if (err) {
                                            errorOccurred = true;
                                            console.error(
                                              "Error inserting tax amount: ",
                                              err.message
                                            );
                                            return rejectInsert(
                                              "Error inserting sale_tax_amounts"
                                            );
                                          }
                                          resolveInsert();
                                        }
                                      );
                                    }
                                  );
                                }
                              );
                            }
                          );

                          Promise.all(taxInsertPromises)
                            .then(() => {
                              db.run(
                                "UPDATE inventory SET quantity_in_stock = quantity_in_stock - ? WHERE product_id = ?",
                                [quantity, product_id],
                                (err) => {
                                  if (err) {
                                    errorOccurred = true;
                                    console.error(
                                      "Error updating inventory: ",
                                      err.message
                                    );
                                  }
                                  resolveSale({
                                    customer_id,
                                    product_id,
                                    quantity,
                                    total_price,
                                  });
                                }
                              );
                            })
                            .catch(rejectSale);
                        }
                      );
                    })
                    .catch(rejectSale);
                }
              );
            });
          }
        );

        Promise.allSettled(processSalePromises)
          .then((results) => {
            results.forEach((result, index) => {
              if (result.status === "fulfilled") {
                saleResponses.push(result.value);
              } else {
                errorOccurred = true;
                console.error(`Sale ${index + 1} failed:`, result.reason);
              }
            });

            if (!errorOccurred) {
              db.run(
                "INSERT INTO invoices (reference_number, customer_id, total_amount, amount_paid, status) VALUES (?, ?, ?, ?, ?)",
                [
                  reference_number,
                  customer_id,
                  totalCartPrice,
                  payment_method == "credit" ? 0 : totalCartPrice,
                  payment_method == "credit" ? "unpaid" : "paid",
                ],
                (err) => {
                  if (err) {
                    errorOccurred = true;
                    console.error("Invoice error: ", err.message);
                  }
                }
              );

              if (payment_method === "credit") {
                db.run(
                  "UPDATE customers SET total_sale_due = total_sale_due + ? WHERE id = ?",
                  [totalCartPrice, customer_id],
                  (err) => {
                    if (err) {
                      errorOccurred = true;
                      console.error(
                        "Error updating customer's total_sale_due: ",
                        err.message
                      );
                    }
                  }
                );
              }
            }

            if (errorOccurred) {
              db.run("ROLLBACK", (rollbackErr) => {
                if (rollbackErr) {
                  return reject(new Error("Failed to rollback transaction"));
                }
                reject(new Error("Error processing sales"));
              });
            } else {
              db.run("COMMIT", (err) => {
                if (err) {
                  return reject(new Error("Failed to commit transaction"));
                }
                resolve(saleResponses);
              });
            }
          })
          .catch((err) => {
            db.run("ROLLBACK", (rollbackErr) => {
              if (rollbackErr) {
                return reject(new Error("Failed to rollback transaction"));
              }
              reject(new Error(err));
            });
          });
      });
    });
  });

  try {
    const result = await dbPromise;
    res
      .status(201)
      .json({ message: "Sales processed successfully", sales: result });
  } catch (error) {
    console.error(error.message);
    res
      .status(400)
      .json({ message: "Error processing sales", error: error.message });
  }
});

router.get("/sales", authenticateUser, (req, res) => {
  db.all(
    `SELECT 
          sales.id, 
          sales.reference_number, 
          sales.customer_id, 
          sales.selling_price, 
          sales.discount_type, 
          sales.discount_amount, 
          sales.payment_method, 
          products.name AS product_name, 
          products.id AS product_id, 
          sales.quantity, 
          sales.total_price, 
          sales.return_status, 
          sales.date,
          COALESCE(
            GROUP_CONCAT(
              taxes.tax_name || ' (' || COALESCE(taxes.tax_rate, 0) || '%): ' || COALESCE(sale_tax_amounts.tax_amount, 0), ' | '
            ), ''
          ) AS applied_taxes
        FROM sales
        JOIN products ON sales.product_id = products.id
        LEFT JOIN sales_taxes ON sales.id = sales_taxes.sale_id
        LEFT JOIN taxes ON sales_taxes.tax_id = taxes.id
        LEFT JOIN sale_tax_amounts ON sales_taxes.id = sale_tax_amounts.sale_tax_id
        GROUP BY 
          sales.id, 
          sales.reference_number, 
          sales.customer_id, 
          sales.selling_price, 
          sales.discount_type, 
          sales.discount_amount, 
          sales.payment_method, 
          products.name, 
          sales.quantity, 
          sales.total_price, 
          sales.return_status, 
          sales.date
        ORDER BY sales.date DESC`,
    (err, rows) => {
      if (err) {
        console.error(err);
        res
          .status(500)
          .json({ message: "Error fetching sales", error: err.message });
      } else {
        res.json(rows);
      }
    }
  );
});

router.post("/sales-return", authenticateUser, async (req, res) => {
  const returnData = req.body;

  // Ensure returnData is an array
  const returnsArray = Array.isArray(returnData) ? returnData : [returnData];

  if (!returnsArray.length) {
    return res.status(400).json({ message: "Invalid return data format." });
  }

  try {
    db.run("BEGIN TRANSACTION");

    const promises = returnsArray.map(async (item) => {
      const {
        sale_id,
        product_id,
        customer_id,
        reference_number,
        return_quantity,
        action, // "restock" or "dispose"
        payment_method,
        selling_price,
        discount_type,
        discount_amount,
        return_type, // "full" or "partial"
        status, // "pending" by default
        reason, // Optional reason for return
      } = item;

      if (
        !sale_id ||
        !product_id ||
        !customer_id ||
        !reference_number ||
        return_quantity <= 0
      ) {
        throw new Error("Invalid return data");
      }

      // Fetch total quantity sold for this sale
      const totalQuantitySold = await new Promise((resolve, reject) => {
        db.get(
          "SELECT quantity FROM sales WHERE id = ?",
          [sale_id],
          (err, row) => {
            if (err) return reject(err);
            if (!row) return reject(new Error("Sale not found"));
            resolve(row.quantity);
          }
        );
      });

      // Fetch total tax amount for this sale
      const totalTax = await new Promise((resolve, reject) => {
        db.all(
          `SELECT sta.tax_amount
             FROM sales_taxes st
             JOIN sale_tax_amounts sta ON st.id = sta.sale_tax_id
             WHERE st.sale_id = ?`,
          [sale_id],
          (err, rows) => {
            if (err) return reject(err);
            const totalTaxAmount = rows.reduce(
              (acc, row) => acc + row.tax_amount,
              0
            );
            resolve(totalTaxAmount);
          }
        );
      });

      // Calculate tax applicable to the returned items
      const returnTax = (return_quantity / totalQuantitySold) * totalTax;

      // Calculate total refund
      const total_refund = return_quantity * selling_price + returnTax;

      // Insert return record
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO returns (
              sale_id, product_id, customer_id, reference_number, return_quantity, 
              action, return_date, selling_price, tax, discount_amount, discount_type, 
              payment_method, total_refund, return_type, status, reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sale_id,
            product_id,
            customer_id,
            reference_number,
            return_quantity,
            action,
            new Date().toISOString(),
            selling_price,
            returnTax,
            discount_amount,
            discount_type,
            payment_method,
            total_refund,
            return_type,
            status || "pending",
            reason || "No reason provided",
          ],
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      });

      // Update inventory if action is "restock"
      if (action === "restock") {
        await new Promise((resolve, reject) => {
          db.run(
            "UPDATE inventory SET quantity_in_stock = quantity_in_stock + ? WHERE product_id = ?",
            [return_quantity, product_id],
            (err) => {
              if (err) return reject(err);
              resolve();
            }
          );
        });
      }

      // Update sales quantity
      await new Promise((resolve, reject) => {
        db.get(
          "SELECT quantity FROM sales WHERE id = ?",
          [sale_id],
          (err, row) => {
            if (err) return reject(err);
            if (!row) return reject(new Error("Sale not found"));

            const newQuantity = row.quantity - return_quantity;
            db.run(
              "UPDATE sales SET quantity = ? WHERE id = ?",
              [newQuantity, sale_id],
              (err) => {
                if (err) return reject(err);
                resolve();
              }
            );
          }
        );
      });

      return { product_id, return_quantity, total_refund };
    });

    const results = await Promise.all(promises);
    db.run("COMMIT");

    res.status(201).json({
      message: "Sales returns processed successfully",
      results,
    });
  } catch (error) {
    db.run("ROLLBACK");
    console.error("Error processing sales returns:", error);
    res.status(500).json({ message: "Error processing sales returns", error });
  }
});

// Get All Sales Returns
router.get("/sales/returns", async (req, res) => {
  try {
    db.all("SELECT * FROM returns", (err, rows) => {
      if (err) {
        console.error("Error fetching returns:", err.message);
        return res.status(500).json({ message: "Internal server error." });
      }

      return res.status(200).json(rows);
    });
  } catch (error) {
    console.error("Unexpected error:", error.message);
    res.status(500).json({ message: "Internal server error." });
  }
});

// Get Single Return by ID
router.get("/sales/returns/:id", async (req, res) => {
  const { id } = req.params;

  try {
    db.get("SELECT * FROM returns WHERE id = ?", [id], (err, row) => {
      if (err) {
        console.error("Error fetching return:", err.message);
        return res.status(500).json({ message: "Internal server error." });
      }

      if (!row) {
        return res.status(404).json({ message: "Return not found." });
      }

      return res.status(200).json(row);
    });
  } catch (error) {
    console.error("Unexpected error:", error.message);
    res.status(500).json({ message: "Internal server error." });
  }
});
// Get all suppliers
router.get("/purchase/returns", authenticateUser, (req, res) => {
  db.all("SELECT * FROM suppliers", (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).send("Error fetching suppliers");
    } else {
      res.json(rows);
    }
  });
});

// ===================== Suppliers Endpoints =====================

// Get all suppliers
router.get("/suppliers", authenticateUser, (req, res) => {
  db.all("SELECT * FROM suppliers", (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).send("Error fetching suppliers");
    } else {
      res.json(rows);
    }
  });
});

// Get a specific supplier by ID
router.get("/suppliers/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM suppliers WHERE contact_id = ?", [id], (err, row) => {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error fetching supplier");
    } else if (!row) {
      res.status(404).send("Supplier not found");
    } else {
      res.json(row);
    }
  });
});
router.post("/suppliers", authenticateUser, (req, res) => {
  const {
    type,
    contact_id,
    business_name,
    name,
    email,
    tax_number,
    pay_term,
    opening_balance,
    advance_balance,
    address,
    mobile,
  } = req.body;

  db.run(
    `INSERT INTO suppliers 
        (type, contact_id, business_name, name, email, tax_number, pay_term, opening_balance, advance_balance, added_on, address, mobile, total_purchase_due, total_purchase_return_due) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      type,
      contact_id,
      business_name,
      name,
      email,
      tax_number,
      pay_term,
      opening_balance || 0,
      advance_balance || 0,
      new Date().toISOString(),
      address,
      mobile,
    ],
    function (err) {
      if (err) {
        console.error("Error adding supplier:", err.message);
        return res.status(500).send("Error adding supplier");
      }

      const supplierId = this.lastID;
      let entriesLogged = 0;
      const totalEntries =
        (opening_balance > 0 ? 1 : 0) + (advance_balance > 0 ? 1 : 0);

      const logJournalEntry = (balance, balanceType, accountId) => {
        const referenceNumber = `SUP-${balanceType}-${supplierId}-${Date.now()}`;
        const date = new Date().toISOString().split("T")[0];
        const description = `${
          balanceType === "OB" ? "Opening" : "Advance"
        } balance for supplier ${business_name || name}`;

        db.get(
          `SELECT account_type FROM chart_of_accounts WHERE id = ?`,
          [accountId],
          (err, row) => {
            if (err || !row) {
              console.error(
                `Error fetching account type for ${balanceType}:`,
                err || "Account not found"
              );
              return;
            }

            const accountType = row.account_type.toLowerCase();
            let debit = 0,
              credit = 0;
            if (accountType === "asset") {
              debit = balance; // Assets increase with debits
            } else if (accountType === "liability") {
              credit = balance; // Liabilities increase with credits
            }

            db.run(
              `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, 'posted')`,
              [referenceNumber, date, description],
              function (err) {
                if (err) {
                  console.error(
                    `Failed to create journal entry for ${balanceType}:`,
                    err
                  );
                  return;
                }

                const journalEntryId = this.lastID;
                db.run(
                  `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                  [journalEntryId, accountId, debit, credit],
                  (err) => {
                    if (err) {
                      console.error(
                        `Failed to create journal entry line for ${balanceType}:`,
                        err
                      );
                    }

                    db.run(
                      `UPDATE chart_of_accounts SET opening_balance_journal_entry_id = ? WHERE id = ?`,
                      [journalEntryId, accountId],
                      (err) => {
                        if (err)
                          console.error(
                            `Failed to update chart_of_accounts for ${balanceType}:`,
                            err
                          );
                        entriesLogged++;
                        if (entriesLogged === totalEntries)
                          res.status(201).json({ id: supplierId, ...req.body });
                      }
                    );
                  }
                );
              }
            );
          }
        );
      };

      if (opening_balance > 0) logJournalEntry(opening_balance, "OB", 5); // Accounts Payable
      if (advance_balance > 0) logJournalEntry(advance_balance, "ADV", 11); // Advance Payments

      if (totalEntries === 0)
        res.status(201).json({ id: supplierId, ...req.body });
    }
  );
});
router.put("/suppliers/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const {
    type,
    contact_id,
    business_name,
    name,
    email,
    tax_number,
    pay_term,
    opening_balance,
    advance_balance,
    address,
    mobile,
    total_purchase_due,
    total_purchase_return_due,
    active_status,
  } = req.body;

  db.get(
    "SELECT opening_balance, advance_balance FROM suppliers WHERE id = ?",
    [id],
    (err, row) => {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error retrieving supplier data.");
      }
      if (!row) return res.status(404).send("Supplier not found.");

      const fields = [];
      const values = [];

      if (type) fields.push("type = ?"), values.push(type);
      if (contact_id) fields.push("contact_id = ?"), values.push(contact_id);
      if (business_name)
        fields.push("business_name = ?"), values.push(business_name);
      if (name) fields.push("name = ?"), values.push(name);
      if (email) fields.push("email = ?"), values.push(email);
      if (tax_number) fields.push("tax_number = ?"), values.push(tax_number);
      if (pay_term) fields.push("pay_term = ?"), values.push(pay_term);
      if (opening_balance !== undefined)
        fields.push("opening_balance = ?"), values.push(opening_balance);
      if (advance_balance !== undefined)
        fields.push("advance_balance = ?"), values.push(advance_balance);
      if (address) fields.push("address = ?"), values.push(address);
      if (mobile) fields.push("mobile = ?"), values.push(mobile);
      if (total_purchase_due !== undefined)
        fields.push("total_purchase_due = ?"), values.push(total_purchase_due);
      if (total_purchase_return_due !== undefined)
        fields.push("total_purchase_return_due = ?"),
          values.push(total_purchase_return_due);
      if (active_status !== undefined)
        fields.push("active_status = ?"), values.push(active_status);

      values.push(id);
      if (fields.length === 0)
        return res.status(400).send("No fields to update.");

      db.run(
        `UPDATE suppliers SET ${fields.join(", ")} WHERE id = ?`,
        values,
        function (err) {
          if (err) {
            console.error("Error updating supplier:", err.message);
            return res.status(500).send("Error updating supplier");
          }

          let entriesLogged = 0;
          const totalEntries =
            (opening_balance > 0 ? 1 : 0) + (advance_balance > 0 ? 1 : 0);

          const logJournalEntry = (balance, balanceType, accountId) => {
            const referenceNumber = `SUP-${balanceType}-${id}-${Date.now()}`;
            const date = new Date().toISOString().split("T")[0];
            const description = `Updated ${
              balanceType === "OB" ? "Opening" : "Advance"
            } balance for supplier ${business_name || name}`;

            db.get(
              `SELECT account_type FROM chart_of_accounts WHERE id = ?`,
              [accountId],
              (err, row) => {
                if (err || !row) {
                  console.error(
                    `Error fetching account type for ${balanceType}:`,
                    err || "Account not found"
                  );
                  return;
                }

                const accountType = row.account_type.toLowerCase();
                let debit = 0,
                  credit = 0;
                if (accountType === "asset") debit = balance;
                else if (accountType === "liability") credit = balance;

                db.run(
                  `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, 'posted')`,
                  [referenceNumber, date, description],
                  function (err) {
                    if (!err) {
                      const journalEntryId = this.lastID;
                      db.run(
                        `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                        [journalEntryId, accountId, debit, credit],
                        () => {
                          db.run(
                            `UPDATE chart_of_accounts SET opening_balance_journal_entry_id = ? WHERE id = ?`,
                            [journalEntryId, accountId],
                            () => {
                              entriesLogged++;
                              if (entriesLogged === totalEntries)
                                res.status(200).json({ id, ...req.body });
                            }
                          );
                        }
                      );
                    }
                  }
                );
              }
            );
          };

          if (opening_balance > 0) logJournalEntry(opening_balance, "OB", 5);
          if (advance_balance > 0) logJournalEntry(advance_balance, "ADV", 11);

          if (totalEntries === 0) res.status(200).json({ id, ...req.body });
        }
      );
    }
  );
});

// Delete a supplier
router.delete("/suppliers/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM suppliers WHERE contact_id = ?", [id], function (err) {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error deleting supplier");
    } else if (this.changes === 0) {
      res.status(404).send("Supplier not found");
    } else {
      res.status(204).send();
    }
  });
});

// Get all purchase orders for a specific supplier
router.get(
  "/suppliers/purchase_orders/:supplierId",
  authenticateUser,
  (req, res) => {
    const { supplierId } = req.params;

    const query = `
      SELECT * 
      FROM purchase_orders 
      WHERE supplier_id = ?
    `;

    db.all(query, [supplierId], (err, rows) => {
      if (err) {
        console.error(err.message);
        res.status(500).send("Error fetching purchase orders for supplier.");
      } else if (rows.length === 0) {
        res.status(404).send("No purchase orders found for this supplier.");
      } else {
        res.json(rows);
      }
    });
  }
);

// Update supplier active status
router.patch("/suppliers/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { active_status } = req.body;

  // Update the active_status field for the customer
  const query = "UPDATE suppliers SET active_status = ? WHERE contact_id = ?";

  db.run(query, [active_status, id], function (err) {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error updating active status");
    } else if (this.changes === 0) {
      res.status(404).send("Supplier not found");
    } else {
      res.json({ id, active_status });
    }
  });
});

// ===================== Documents Endpoints =====================

// CREATE: Add multiple or single documents
router.post(
  "/documents",
  documentUpload.array("files"),
  authenticateUser,
  async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    const { transaction_type, reference_number } = req.body;
    const uploadedDocuments = [];

    try {
      await Promise.all(
        req.files.map((file) => {
          return new Promise((resolve, reject) => {
            const filePath = `/uploads/documents/${file.filename}`;
            const query = `INSERT INTO documents (transaction_type, reference_number, document_name, file_path) VALUES (?, ?, ?, ?)`;
            db.run(
              query,
              [transaction_type, reference_number, file.originalname, filePath],
              function (err) {
                if (err) return reject(err);
                uploadedDocuments.push({
                  id: this.lastID,
                  transaction_type,
                  reference_number,
                  document_name: file.originalname,
                  file_path: filePath,
                });
                resolve();
              }
            );
          });
        })
      );

      return res.status(201).json(uploadedDocuments);
    } catch (error) {
      console.error("Error during document upload:", error.message);
      return res.status(500).json({ message: "Error during document upload" });
    }
  }
);

// READ: Get all documents
router.get("/documents", authenticateUser, (req, res) => {
  const query = `SELECT * FROM documents`;
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.status(200).json(rows);
  });
});

// READ: Get a document by ID
router.get("/documents/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const query = `SELECT * FROM documents WHERE id = ?`;
  db.get(query, [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.status(200).json(row);
  });
});

// DELETE: Delete a document by ID
router.delete("/documents/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const query = `DELETE FROM documents WHERE id = ?`;
  db.run(query, [id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.status(200).json({ message: "Document deleted successfully" });
  });
});

router.get(
  "/documents/by-reference/:referenceNumber",
  authenticateUser,
  (req, res) => {
    const { referenceNumber } = req.params;
    const query = `SELECT * FROM documents WHERE reference_number = ?`;

    db.all(query, [referenceNumber], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.status(200).json(rows);
    });
  }
);

// ===================== Customers Endpoints =====================

// Get all customers
router.get("/customers", authenticateUser, (req, res) => {
  db.all("SELECT * FROM customers", (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).send("Error fetching customers");
    } else {
      res.json(rows);
    }
  });
});

// Get a specific customer by ID
router.get("/customers/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM customers WHERE contact_id = ?", [id], (err, row) => {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error fetching customer");
    } else if (!row) {
      res.status(404).send("Customer not found");
    } else {
      res.json(row);
    }
  });
});

router.post("/customers", authenticateUser, (req, res) => {
  const {
    contact_id,
    customer_type,
    business_name,
    name,
    email,
    tax_number,
    credit_limit,
    pay_term,
    opening_balance,
    advance_balance,
    address,
    mobile,
    customer_group,
  } = req.body;

  const stmt = db.prepare(
    `INSERT INTO customers 
      (contact_id, customer_type, business_name, name, email, tax_number, credit_limit, pay_term, opening_balance, advance_balance, added_on, address, mobile, customer_group, total_sale_due, total_sell_return_due) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
  );

  stmt.run(
    contact_id,
    customer_type,
    business_name,
    name,
    email,
    tax_number,
    credit_limit || 0,
    pay_term || 0,
    opening_balance || 0,
    advance_balance || 0,
    new Date().toISOString(),
    address,
    mobile,
    customer_group,
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error adding customer");
      }

      const customerId = this.lastID;
      let entriesLogged = 0;
      const totalEntries =
        (opening_balance > 0 ? 1 : 0) + (advance_balance > 0 ? 1 : 0);

      const logJournalEntry = (balance, balanceType, accountId) => {
        const referenceNumber = `CUS-${balanceType}-${customerId}-${Date.now()}`;
        const date = new Date().toISOString().split("T")[0];
        const description = `${
          balanceType === "OB" ? "Opening" : "Advance"
        } balance for customer ${business_name || name}`;

        // Get the account type from chart_of_accounts
        db.get(
          `SELECT account_type FROM chart_of_accounts WHERE id = ?`,
          [accountId],
          (err, row) => {
            if (err) {
              console.error(
                `Failed to fetch account type for ${balanceType}:`,
                err
              );
              return;
            }

            if (!row) {
              console.error(
                `Account ID ${accountId} not found in chart_of_accounts.`
              );
              return;
            }

            const accountType = row.account_type.toLowerCase(); // "asset" or "liability"

            // Determine debit or credit based on account type
            let debit = 0,
              credit = 0;
            if (accountType === "asset") {
              debit = balance; // Assets increase with debits
            } else if (accountType === "liability") {
              credit = balance; // Liabilities increase with credits
            }

            // Insert into journal_entries
            db.run(
              `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, 'posted')`,
              [referenceNumber, date, description],
              function (err) {
                if (err) {
                  console.error(
                    `Failed to create journal entry for ${balanceType}:`,
                    err
                  );
                  return;
                }

                const journalEntryId = this.lastID;

                // Insert into journal_entry_lines
                db.run(
                  `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                  [journalEntryId, accountId, debit, credit],
                  (err) => {
                    if (err) {
                      console.error(
                        `Failed to create journal entry line for ${balanceType}:`,
                        err
                      );
                    }

                    // Update chart_of_accounts with opening_balance_journal_entry_id
                    db.run(
                      `UPDATE chart_of_accounts SET opening_balance_journal_entry_id = ? WHERE id = ?`,
                      [journalEntryId, accountId],
                      (err) => {
                        if (err) {
                          console.error(
                            `Failed to update chart_of_accounts for ${balanceType}:`,
                            err
                          );
                        }

                        entriesLogged++;
                        if (entriesLogged === totalEntries) {
                          res.status(201).json({ id: customerId, ...req.body });
                        }
                      }
                    );
                  }
                );
              }
            );
          }
        );
      };

      if (opening_balance > 0) logJournalEntry(opening_balance, "OB", 4); // Accounts Receivable (OB)
      if (advance_balance > 0) logJournalEntry(advance_balance, "ADV", 12); // Advance Payments (ADV)

      if (totalEntries === 0) {
        res.status(201).json({ id: customerId, ...req.body });
      }
    }
  );
});

router.put("/customers/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const {
    contact_id,
    customer_type,
    business_name,
    name,
    email,
    tax_number,
    credit_limit,
    pay_term,
    opening_balance,
    advance_balance,
    address,
    mobile,
    customer_group,
  } = req.body;

  const fields = [];
  const values = [];

  if (contact_id !== undefined) {
    fields.push("contact_id = ?");
    values.push(contact_id);
  }
  if (business_name !== undefined) {
    fields.push("business_name = ?");
    values.push(business_name);
  }
  if (name !== undefined) {
    fields.push("name = ?");
    values.push(name);
  }
  if (email !== undefined) {
    fields.push("email = ?");
    values.push(email);
  }
  if (tax_number !== undefined) {
    fields.push("tax_number = ?");
    values.push(tax_number);
  }
  if (credit_limit !== undefined) {
    fields.push("credit_limit = ?");
    values.push(credit_limit);
  }
  if (pay_term !== undefined) {
    fields.push("pay_term = ?");
    values.push(pay_term);
  }
  if (opening_balance !== undefined) {
    fields.push("opening_balance = ?");
    values.push(opening_balance);
  }
  if (advance_balance !== undefined) {
    fields.push("advance_balance = ?");
    values.push(advance_balance);
  }
  if (address !== undefined) {
    fields.push("address = ?");
    values.push(address);
  }
  if (mobile !== undefined) {
    fields.push("mobile = ?");
    values.push(mobile);
  }
  if (customer_group !== undefined) {
    fields.push("customer_group = ?");
    values.push(customer_group);
  }
  if (customer_type !== undefined) {
    fields.push("customer_type = ?");
    values.push(customer_type);
  }

  // Ensure fields are present before running update
  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update." });
  }

  // Add ID at the end for WHERE clause
  values.push(id);

  const query = `UPDATE customers SET ${fields.join(
    ", "
  )} WHERE contact_id = ?`;

  db.run(query, values, function (err) {
    if (err) {
      console.error("Error updating customer:", err.message);
      return res.status(500).send("Error updating customer");
    }
    if (this.changes === 0) return res.status(404).send("Customer not found");

    let entriesLogged = 0;
    const totalEntries =
      (opening_balance > 0 ? 1 : 0) + (advance_balance > 0 ? 1 : 0);

    const logJournalEntry = (balance, balanceType, accountId) => {
      const referenceNumber = `CUS-${balanceType}-${id}-${Date.now()}`;
      const date = new Date().toISOString().split("T")[0];
      const description = `${
        balanceType === "OB" ? "Opening" : "Advance"
      } balance for customer ${business_name || name}`;

      // Get the account type from chart_of_accounts
      db.get(
        `SELECT account_type FROM chart_of_accounts WHERE id = ?`,
        [accountId],
        (err, row) => {
          if (err) {
            console.error(
              `Failed to fetch account type for ${balanceType}:`,
              err
            );
            return;
          }

          if (!row) {
            console.error(
              `Account ID ${accountId} not found in chart_of_accounts.`
            );
            return;
          }

          const accountType = row.account_type.toLowerCase(); // "asset" or "liability"

          // Determine debit or credit based on account type
          let debit = 0,
            credit = 0;
          if (accountType === "asset") {
            debit = balance; // Assets increase with debits
          } else if (accountType === "liability") {
            credit = balance; // Liabilities increase with credits
          }

          // Insert into journal_entries
          db.run(
            `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, 'posted')`,
            [referenceNumber, date, description],
            function (err) {
              if (err) {
                console.error(
                  `Failed to create journal entry for ${balanceType}:`,
                  err
                );
                return;
              }

              const journalEntryId = this.lastID;

              // Insert into journal_entry_lines
              db.run(
                `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                [journalEntryId, accountId, debit, credit],
                (err) => {
                  if (err) {
                    console.error(
                      `Failed to create journal entry line for ${balanceType}:`,
                      err
                    );
                  }

                  // Update chart_of_accounts with opening_balance_journal_entry_id
                  db.run(
                    `UPDATE chart_of_accounts SET opening_balance_journal_entry_id = ? WHERE id = ?`,
                    [journalEntryId, accountId],
                    (err) => {
                      if (err) {
                        console.error(
                          `Failed to update chart_of_accounts for ${balanceType}:`,
                          err
                        );
                      }

                      entriesLogged++;
                      if (entriesLogged === totalEntries) {
                        res.status(200).json({ id, ...req.body });
                      }
                    }
                  );
                }
              );
            }
          );
        }
      );
    };

    if (opening_balance > 0) logJournalEntry(opening_balance, "OB", 4); // Accounts Receivable (OB)
    if (advance_balance > 0) logJournalEntry(advance_balance, "ADV", 12); // Advance Payments (ADV)

    if (totalEntries === 0) {
      res.status(200).json({ id, ...req.body });
    }
  });
});

// Delete a customer
router.delete("/customers/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM customers WHERE contact_id = ?", [id], function (err) {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error deleting customer");
    } else if (this.changes === 0) {
      res.status(404).send("Customer not found");
    } else {
      res.status(204).send();
    }
  });
});
// Update customer active status
router.patch("/customers/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { active_status } = req.body;

  // Update the active_status field for the customer
  const query = "UPDATE customers SET active_status = ? WHERE contact_id = ?";

  db.run(query, [active_status, id], function (err) {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error updating active status");
    } else if (this.changes === 0) {
      res.status(404).send("Customer not found");
    } else {
      res.json({ id, active_status });
    }
  });
});
// ===================== Adjsutments Endpoints =====================
const createJournalEntry = (adjustment) => {
  return new Promise((resolve, reject) => {
    const {
      id,
      account_id, // Use account_code instead of account_id
      adjustment_type,
      amount,
      reason,
      date,
      entry_type,
      reference_number,
    } = adjustment;

    // Handle different account mappings based on adjustment type
    const getAccountMapping = (type) => {
      const mappings = {
        correction: { contra_account: "7001" },
        reconciliation: { contra_account: "7002" },
        depreciation: { contra_account: "7003" },
        accrual: { contra_account: "7004" },
        prepaid: { contra_account: "7005" },
        deferral: { contra_account: "7006" },
        "write-off": { contra_account: "7007" },
        tax: { contra_account: "7008" },
      };
      return mappings[type] || { contra_account: "7000" }; // Default contra account
    };

    const { contra_account } = getAccountMapping(adjustment_type);

    // Fetch account_id for both main and contra accounts
    db.get(
      `SELECT id FROM chart_of_accounts WHERE id = ?`,
      [account_id],
      (err, account) => {
        if (err || !account) return reject(err || "Account not found");
        const main_account_id = account.id;

        db.get(
          `SELECT id FROM chart_of_accounts WHERE account_code = ?`,
          [contra_account],
          (err, contraAccount) => {
            if (err || !contraAccount)
              return reject(err || "Contra account not found");
            const contra_account_id = contraAccount.id;

            // Determine debit and credit accounts
            const debit_account_id =
              entry_type === "debit" ? main_account_id : contra_account_id;
            const credit_account_id =
              entry_type === "credit" ? main_account_id : contra_account_id;

            // Insert into journal_entries
            db.run(
              `INSERT INTO journal_entries (
                  reference_number, 
                  date, 
                  description, 
                  status,
                  adjustment_type
                ) VALUES (?, ?, ?, ?, ?)`,
              [reference_number, date, reason, "posted", adjustment_type],
              function (err) {
                if (err) return reject(err);
                const journal_entry_id = this.lastID;

                // Insert debit entry
                db.run(
                  `INSERT INTO journal_entry_lines (
                      journal_entry_id, 
                      account_id, 
                      debit, 
                      credit,
                      entry_type
                    ) VALUES (?, ?, ?, ?, ?)`,
                  [journal_entry_id, debit_account_id, amount, 0, "debit"],
                  function (err) {
                    if (err) return reject(err);

                    // Insert credit entry
                    db.run(
                      `INSERT INTO journal_entry_lines (
                          journal_entry_id, 
                          account_id, 
                          debit, 
                          credit,
                          entry_type
                        ) VALUES (?, ?, ?, ?, ?)`,
                      [
                        journal_entry_id,
                        credit_account_id,
                        0,
                        amount,
                        "credit",
                      ],
                      function (err) {
                        if (err) return reject(err);

                        // Update adjustment record with journal_entry_id
                        db.run(
                          `UPDATE adjustments SET journal_entry_id = ? WHERE id = ?`,
                          [journal_entry_id, id]
                        );
                        resolve(journal_entry_id);
                      }
                    );
                  }
                );
              }
            );
          }
        );
      }
    );
  });
};

// CREATE ADJUSTMENT
router.post("/adjustments", authenticateUser, (req, res) => {
  const {
    account_id,
    adjustment_type,
    amount,
    reason,
    date,
    entry_type,
    document_reference,
    created_by,
    affected_periods,
  } = req.body;

  const reference_number = `ADJ-${new Date().getFullYear()}-${Math.random()
    .toString(36)
    .substr(2, 9)
    .toUpperCase()}`;

  db.run(
    `INSERT INTO adjustments (
        account_id,
        adjustment_type,
        amount,
        reason,
        date,
        entry_type,
        reference_number,
        status,
        document_reference,
        created_by,
        created_at,
        affected_period_year,
        affected_period_quarter,
        affected_period_month
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      account_id,
      adjustment_type,
      amount,
      reason,
      date,
      entry_type,
      reference_number,
      "posted",
      document_reference,
      created_by,
      new Date().toISOString(),
      affected_periods.fiscal_year,
      affected_periods.fiscal_quarter,
      affected_periods.fiscal_month,
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      const adjustment = {
        id: this.lastID,
        ...req.body,
        reference_number,
        status: "posted",
      };
      console.log(adjustment);
      createJournalEntry(adjustment)
        .then(() =>
          res.json({
            message: "Adjustment created successfully",
            adjustment,
          })
        )
        .catch((error) => res.status(500).json({ error }));
    }
  );
});

// READ ADJUSTMENTS
router.get("/adjustments", authenticateUser, (req, res) => {
  const { startDate, endDate, type, account, status } = req.query;

  let query = `
      SELECT 
        a.*,
        acc.account_name,
        acc.account_code
      FROM adjustments a
      LEFT JOIN chart_of_accounts acc ON a.account_id = acc.id
      WHERE 1=1
    `;

  const params = [];

  if (startDate && endDate) {
    query += ` AND date BETWEEN ? AND ?`;
    params.push(startDate, endDate);
  }

  if (type) {
    query += ` AND adjustment_type = ?`;
    params.push(type);
  }

  if (account) {
    query += ` AND account_id = ?`;
    params.push(account);
  }

  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }

  query += ` ORDER BY date DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// UPDATE ADJUSTMENT
router.put("/adjustments/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const {
    account_id,
    adjustment_type,
    amount,
    reason,
    date,
    entry_type,
    document_reference,
    status,
  } = req.body;

  db.get(
    `SELECT * FROM adjustments WHERE id = ?`,
    [id],
    (err, oldAdjustment) => {
      if (err || !oldAdjustment)
        return res.status(404).json({ error: "Adjustment not found" });

      db.run(
        `UPDATE adjustments 
         SET account_id = ?,
             adjustment_type = ?,
             amount = ?,
             reason = ?,
             date = ?,
             entry_type = ?,
             document_reference = ?,
             status = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          account_id,
          adjustment_type,
          amount,
          reason,
          date,
          entry_type,
          document_reference,
          status,
          new Date().toISOString(),
          id,
        ],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          // Delete old journal entry
          db.run(
            `DELETE FROM journal_entries WHERE id = ?`,
            [oldAdjustment.journal_entry_id],
            (err) => {
              if (err) return res.status(500).json({ error: err.message });

              const updatedAdjustment = {
                id,
                ...req.body,
                reference_number: oldAdjustment.reference_number,
              };

              createJournalEntry(updatedAdjustment)
                .then(() =>
                  res.json({
                    message: "Adjustment updated successfully",
                    adjustment: updatedAdjustment,
                  })
                )
                .catch((error) => res.status(500).json({ error }));
            }
          );
        }
      );
    }
  );
});

// DELETE ADJUSTMENT
router.delete("/adjustments/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  db.get(`SELECT * FROM adjustments WHERE id = ?`, [id], (err, adjustment) => {
    if (err || !adjustment)
      return res.status(404).json({ error: "Adjustment not found" });

    const journalEntryId = adjustment.journal_entry_id;

    db.serialize(() => {
      db.run(
        `DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`,
        [journalEntryId],
        (err) => {
          if (err)
            return res
              .status(500)
              .json({ error: "Failed to delete journal entry lines." });

          db.run(
            `DELETE FROM journal_entries WHERE id = ?`,
            [journalEntryId],
            (err) => {
              if (err)
                return res
                  .status(500)
                  .json({ error: "Failed to delete journal entry." });

              db.run(
                `DELETE FROM adjustments WHERE id = ?`,
                [id],
                function (err) {
                  if (err)
                    return res
                      .status(500)
                      .json({ error: "Failed to delete adjustment." });

                  res.json({
                    message:
                      "Adjustment, related journal entry, and journal entry lines deleted successfully.",
                  });
                }
              );
            }
          );
        }
      );
    });
  });
});

// ===================== Funds Transfer Endpoints =====================
router.post("/funds-transfer", authenticateUser, (req, res) => {
  const { fromAccount, toAccount, amount, description, date } = req.body;
  const user_id = 1;

  if (!fromAccount || !toAccount || !amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid input values." });
  }

  const referenceNumber = `FT-${Date.now()}`;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    // Insert into funds_transfers (New table for faster tracking)
    db.run(
      `INSERT INTO funds_transfers (reference_number, from_account, to_account, amount, date, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [referenceNumber, fromAccount, toAccount, amount, date, description],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: err.message });
        }

        const transferId = this.lastID;

        // Insert into journal_entries
        db.run(
          `INSERT INTO journal_entries (reference_number, date, description, status, adjustment_type)
             VALUES (?, ?, ?, 'posted', 'FUNDS TRANSFER')`,
          [referenceNumber, date, description],
          function (err) {
            if (err) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: err.message });
            }

            const journalEntryId = this.lastID;

            // Insert Debit Entry for the To-Account
            db.run(
              `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, entry_type)
                 VALUES (?, ?, ?, 0, 'FUNDS TRANSFER')`,
              [journalEntryId, toAccount, amount],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }
              }
            );

            // Insert Credit Entry for the From-Account
            db.run(
              `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, entry_type)
                 VALUES (?, ?, 0, ?, 'FUNDS TRANSFER')`,
              [journalEntryId, fromAccount, amount],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }
              }
            );

            // Insert into audit_trails
            db.run(
              `INSERT INTO audit_trails (user_id, table_name, record_id, action, changes)
                 VALUES (?, 'funds_transfer', ?, 'insert', ?)`,
              [
                user_id,
                transferId,
                JSON.stringify({
                  fromAccount,
                  toAccount,
                  amount,
                  date,
                  description,
                }),
              ],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }
              }
            );

            db.run("COMMIT"); // Commit transaction
            res
              .status(201)
              .json({ message: "Funds transferred successfully", transferId });
          }
        );
      }
    );
  });
});

// GET ALL FUNDS TRANSFERS
router.get("/funds-transfer", authenticateUser, (req, res) => {
  db.all(
    `SELECT ft.id, ft.reference_number, ft.date, ft.amount, ft.description, ft.status,
              ca_from.account_name AS from_account, 
              ca_to.account_name AS to_account
       FROM funds_transfers ft
       JOIN chart_of_accounts ca_from ON ft.from_account = ca_from.id
       JOIN chart_of_accounts ca_to ON ft.to_account = ca_to.id`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

router.post("/funds-transfer/reverse/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const user_id = 1;
  db.get(
    `SELECT * FROM funds_transfers WHERE id = ?`,
    [id],
    (err, transfer) => {
      if (err || !transfer) {
        return res.status(404).json({ error: "Transfer not found" });
      }

      if (transfer.status === "REVERSED") {
        return res.status(400).json({ error: "Transfer already reversed" });
      }

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        const reverseReference = `REV-${transfer.reference_number}`;

        // Insert Reversal Entry in journal_entries
        db.run(
          `INSERT INTO journal_entries (reference_number, date, description, status, adjustment_type)
           VALUES (?, ?, ?, 'posted', 'FUNDS TRANSFER REVERSAL')`,
          [
            reverseReference,
            transfer.date,
            `Reversal: ${transfer.description}`,
          ],
          function (err) {
            if (err) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: err.message });
            }

            const reversalEntryId = this.lastID;

            // Reverse Debit & Credit for Reversal Entry
            db.run(
              `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, entry_type)
               VALUES (?, ?, 0, ?, 'FUNDS TRANSFER REVERSAL')`,
              [reversalEntryId, transfer.to_account, transfer.amount],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }
              }
            );

            db.run(
              `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, entry_type)
               VALUES (?, ?, ?, 0, 'FUNDS TRANSFER REVERSAL')`,
              [reversalEntryId, transfer.from_account, transfer.amount],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }
              }
            );

            // Mark transfer as REVERSED in funds_transfers
            db.run(
              `UPDATE funds_transfers SET status = 'REVERSED' WHERE id = ?`,
              [id],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }
              }
            );

            // Log Reversal in audit_trails
            db.run(
              `INSERT INTO audit_trails (user_id, table_name, record_id, action, changes)
               VALUES (?, 'funds_transfer', ?, 'update', ?)`,
              [user_id, id, JSON.stringify({ status: "REVERSED" })],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }
              }
            );

            db.run("COMMIT");
            res.json({ message: "Funds transfer reversed successfully" });
          }
        );
      });
    }
  );
});

// DELETE FUNDS TRANSFER
router.delete("/funds-transfer/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  db.get(
    `SELECT * FROM journal_entries WHERE id = ? AND adjustment_type = 'FUNDS TRANSFER'`,
    [id],
    (err, entry) => {
      if (err || !entry)
        return res.status(404).json({ error: "Transfer not found" });

      db.serialize(() => {
        db.run(
          `DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`,
          [id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(`DELETE FROM journal_entries WHERE id = ?`, [id], (err) => {
              if (err) return res.status(500).json({ error: err.message });

              db.run(
                `INSERT INTO audit_trails (user_id, table_name, record_id, action, changes)
               VALUES (?, 'funds_transfer', ?, 'delete', ?)`,
                [1, id, JSON.stringify({ message: "Funds transfer deleted" })],
                function (err) {
                  if (err) return res.status(500).json({ error: err.message });
                }
              );

              res.json({ message: "Funds transfer deleted successfully" });
            });
          }
        );
      });
    }
  );
});
// ===================== Customer Groups Endpoints =====================

// Get all customer groups
router.get("/customer_groups", authenticateUser, (req, res) => {
  db.all("SELECT * FROM customer_groups", (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).send("Error fetching customer groups");
    } else {
      res.json(rows);
    }
  });
});

// Get a specific customer group by ID
router.get("/customer_groups/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM customer_groups WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error fetching customer group");
    } else if (!row) {
      res.status(404).send("Customer group not found");
    } else {
      res.json(row);
    }
  });
});

// Add a new customer group
router.post("/customer_groups", authenticateUser, (req, res) => {
  const {
    group_name,
    discount,
    discount_type,
    tax_type,
    tax_rate,
    tax_type_details,
    description,
    active_status,
  } = req.body;

  const stmt = db.prepare(
    `INSERT INTO customer_groups 
      (group_name, discount, discount_type, tax_type, tax_rate, tax_type_details, description, active_status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  stmt.run(
    group_name,
    discount || 0,
    discount_type || "percentage",
    tax_type || "VAT",
    tax_rate || 0,
    tax_type_details || "",
    description || "",
    active_status || 1,
    function (err) {
      if (err) {
        console.error(err.message);
        res.status(500).send("Error adding customer group");
      } else {
        res.status(201).json({ id: this.lastID, ...req.body });
      }
    }
  );
});

// Update a customer group
router.put("/customer_groups/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const {
    group_name,
    discount,
    discount_type,
    tax_type,
    tax_rate,
    tax_type_details,
    description,
    active_status,
  } = req.body;

  const fields = [];
  const values = [];

  if (group_name) {
    fields.push("group_name = ?");
    values.push(group_name);
  }
  if (discount !== undefined) {
    fields.push("discount = ?");
    values.push(discount);
  }
  if (discount_type) {
    fields.push("discount_type = ?");
    values.push(discount_type);
  }
  if (tax_type) {
    fields.push("tax_type = ?");
    values.push(tax_type);
  }
  if (tax_rate !== undefined) {
    fields.push("tax_rate = ?");
    values.push(tax_rate);
  }
  if (tax_type_details) {
    fields.push("tax_type_details = ?");
    values.push(tax_type_details);
  }
  if (description) {
    fields.push("description = ?");
    values.push(description);
  }
  if (active_status !== undefined) {
    fields.push("active_status = ?");
    values.push(active_status);
  }

  values.push(id);

  const query = `UPDATE customer_groups SET ${fields.join(", ")} WHERE id = ?`;

  db.run(query, values, function (err) {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error updating customer group");
    } else if (this.changes === 0) {
      res.status(404).send("Customer group not found");
    } else {
      res.json({ id, ...req.body });
    }
  });
});

// Delete a customer group
router.delete("/customer_groups/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM customer_groups WHERE id = ?", [id], function (err) {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error deleting customer group");
    } else if (this.changes === 0) {
      res.status(404).send("Customer group not found");
    } else {
      res.status(204).send();
    }
  });
});

// Update customer group active status
router.patch("/customer_groups/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { active_status } = req.body;

  // Update the active_status field for the customer group
  const query = "UPDATE customer_groups SET active_status = ? WHERE id = ?";

  db.run(query, [active_status, id], function (err) {
    if (err) {
      console.error(err.message);
      res.status(500).send("Error updating active status");
    } else if (this.changes === 0) {
      res.status(404).send("Customer group not found");
    } else {
      res.json({ id, active_status });
    }
  });
});

// ===================== Server Initialization =====================
// CREATE - Add a new tax
router.post("/taxes", authenticateUser, async (req, res) => {
  const { tax_name, tax_rate, tax_type, account_code } = req.body;

  // Validate required fields
  if (!tax_name || tax_rate === undefined || !tax_type || !account_code) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Validate tax_type
  if (!["inclusive", "exclusive"].includes(tax_type)) {
    return res
      .status(400)
      .json({ error: "Invalid tax type. Must be 'inclusive' or 'exclusive'" });
  }

  // Validate tax_rate is non-negative
  if (tax_rate < 0) {
    return res.status(400).json({ error: "Tax rate cannot be negative" });
  }

  try {
    // First check if the account exists
    const accountExists = await new Promise((resolve, reject) => {
      db.get(
        "SELECT account_code FROM chart_of_accounts WHERE account_code = ?",
        [account_code],
        (err, row) => {
          if (err) reject(err);
          resolve(row !== undefined);
        }
      );
    });

    if (!accountExists) {
      return res.status(400).json({ error: "Invalid account_code" });
    }

    // Insert the new tax record
    db.run(
      `INSERT INTO taxes (tax_name, tax_rate, tax_type, account_id)
         SELECT ?, ?, ?, id
         FROM chart_of_accounts
         WHERE account_code = ?`,
      [tax_name, tax_rate, tax_type, account_code],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) {
            return res.status(409).json({ error: "Tax name already exists" });
          }
          console.error(err);
          return res.status(500).json({ error: "Failed to create tax" });
        }

        res.status(201).json({
          id: this.lastID,
          tax_name,
          tax_rate,
          tax_type,
          account_code,
        });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// READ - Get all taxes
router.get("/taxes", authenticateUser, (req, res) => {
  db.all(
    `SELECT t.id, t.tax_name, t.tax_rate, t.tax_type, coa.account_code, coa.account_name, coa.account_type
       FROM taxes t
       JOIN chart_of_accounts coa ON t.account_id = coa.id
       ORDER BY t.tax_name`,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch taxes" });
      }
      res.json(rows);
    }
  );
});

// READ - Get a single tax by ID
router.get("/taxes/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  db.get(
    `SELECT t.id, t.tax_name, t.tax_rate, t.tax_type, coa.account_code, coa.account_name, coa.account_type
       FROM taxes t
       JOIN chart_of_accounts coa ON t.account_id = coa.id
       WHERE t.id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch tax" });
      }
      if (!row) {
        return res.status(404).json({ error: "Tax not found" });
      }
      res.json(row);
    }
  );
});

// UPDATE - Update a tax
router.put("/taxes/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { tax_name, tax_rate, tax_type, account_code } = req.body;

  // Validate required fields
  if (!tax_name || tax_rate === undefined || !tax_type || !account_code) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Validate tax_type
  if (!["inclusive", "exclusive"].includes(tax_type)) {
    return res
      .status(400)
      .json({ error: "Invalid tax type. Must be 'inclusive' or 'exclusive'" });
  }

  // Validate tax_rate is non-negative
  if (tax_rate < 0) {
    return res.status(400).json({ error: "Tax rate cannot be negative" });
  }

  try {
    // Check if the account exists
    const accountExists = await new Promise((resolve, reject) => {
      db.get(
        "SELECT account_code FROM chart_of_accounts WHERE account_code = ?",
        [account_code],
        (err, row) => {
          if (err) reject(err);
          resolve(row !== undefined);
        }
      );
    });

    if (!accountExists) {
      return res.status(400).json({ error: "Invalid account_code" });
    }

    // Update the tax record
    db.run(
      `UPDATE taxes
         SET tax_name = ?,
             tax_rate = ?,
             tax_type = ?,
             account_id = (SELECT id FROM chart_of_accounts WHERE account_code = ?)
         WHERE id = ?`,
      [tax_name, tax_rate, tax_type, account_code, id],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) {
            return res.status(409).json({ error: "Tax name already exists" });
          }
          console.error(err);
          return res.status(500).json({ error: "Failed to update tax" });
        }

        if (this.changes === 0) {
          return res.status(404).json({ error: "Tax not found" });
        }

        res.json({
          id: parseInt(id),
          tax_name,
          tax_rate,
          tax_type,
          account_code,
        });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE - Delete a tax
router.delete("/taxes/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  db.run("DELETE FROM taxes WHERE id = ?", [id], function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to delete tax" });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: "Tax not found" });
    }

    res.json({ message: "Tax deleted successfully" });
  });
});

// ==================== CREATE TRANSACTION ====================
// ✅ 1. Get all transactions
router.get("/transactions", authenticateUser, (req, res) => {
  db.all(
    "SELECT * FROM transactions ORDER BY transaction_date DESC",
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// ✅ 2. Get a single transaction by ID
router.get("/transactions/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM transactions WHERE id = ?", [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ message: "Transaction not found" });
    }
    res.json(row);
  });
});

/// ✅ 3. Create a new transaction
router.post("/transactions", authenticateUser, (req, res) => {
  const {
    transaction_date,
    amount,
    credit_account_id,
    description,
    debit_account_id,
  } = req.body;

  const reference_number = `TXN${Date.now()}`;
  const transaction_description = description || "Transaction entry";

  // ✅ Insert Journal Entry
  db.run(
    `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, 'posted')`,
    [reference_number, transaction_date, transaction_description],
    function (err) {
      if (err) {
        console.error("Error creating journal entry:", err.message);
        return res.status(500).send("Error creating journal entry");
      }

      const journal_entry_id = this.lastID;

      // ✅ Insert Debit Entry (debit_account_id)
      db.run(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, 0)`,
        [journal_entry_id, debit_account_id, amount],
        function (err) {
          if (err) {
            console.error(
              "Error creating debit journal entry line:",
              err.message
            );
            return res
              .status(500)
              .send("Error creating debit journal entry line");
          }

          // ✅ Insert Credit Entry (credit_account_id)
          db.run(
            `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, 0, ?)`,
            [journal_entry_id, credit_account_id, amount],
            function (err) {
              if (err) {
                console.error(
                  "Error creating credit journal entry line:",
                  err.message
                );
                return res
                  .status(500)
                  .send("Error creating credit journal entry line");
              }

              // ✅ Final response
              res.status(201).json({
                message: "Transaction recorded successfully",
                journal_entry_id: journal_entry_id,
              });
            }
          );
        }
      );
    }
  );
});

router.put("/transactions/:id", authenticateUser, (req, res) => {
  const transactionId = req.params.id;
  const {
    transaction_date,
    amount,
    account_id,
    description,
    payment_method_id,
  } = req.body;

  db.get(
    `SELECT journal_entry_id FROM transactions WHERE id = ?`,
    [transactionId],
    (err, transaction) => {
      if (err || !transaction) {
        console.error(
          "Transaction not found:",
          err?.message || "Transaction does not exist"
        );
        return res.status(404).send("Transaction not found");
      }

      const journal_entry_id = transaction.journal_entry_id;

      // Step 1: Update the journal entry
      db.run(
        `UPDATE journal_entries SET date = ?, description = ? WHERE id = ?`,
        [
          transaction_date,
          description || "Updated transaction entry",
          journal_entry_id,
        ],
        function (err) {
          if (err) {
            console.error("Error updating journal entry:", err.message);
            return res.status(500).send("Error updating journal entry");
          }

          // Step 2: Remove existing journal entry lines
          db.run(
            `DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`,
            [journal_entry_id],
            function (err) {
              if (err) {
                console.error(
                  "Error deleting journal entry lines:",
                  err.message
                );
                return res
                  .status(500)
                  .send("Error deleting journal entry lines");
              }

              // Step 3: Fetch new account types
              db.get(
                `SELECT account_type FROM chart_of_accounts WHERE id = ?`,
                [account_id],
                (err, account) => {
                  if (err || !account) {
                    console.error(
                      "Error fetching account type:",
                      err?.message || "Account not found"
                    );
                    return res.status(500).send("Error fetching account type");
                  }

                  db.get(
                    `SELECT account_type FROM chart_of_accounts WHERE id = ?`,
                    [payment_method_id],
                    (err, payment_account) => {
                      if (err || !payment_account) {
                        console.error(
                          "Error fetching payment account type:",
                          err?.message || "Payment account not found"
                        );
                        return res
                          .status(500)
                          .send("Error fetching payment account type");
                      }

                      const transactionAccountType = account.account_type;
                      const paymentAccountType = payment_account.account_type;

                      // Step 4: Determine new debit and credit values
                      let debitAmount = 0,
                        creditAmount = 0;
                      if (
                        ["asset", "expense"].includes(transactionAccountType)
                      ) {
                        debitAmount = amount;
                      } else {
                        creditAmount = amount;
                      }

                      // Step 5: Insert updated journal entry lines for the transaction
                      db.run(
                        `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                        [
                          journal_entry_id,
                          account_id,
                          debitAmount,
                          creditAmount,
                        ],
                        function (err) {
                          if (err) {
                            console.error(
                              "Error inserting transaction journal entry line:",
                              err.message
                            );
                            return res
                              .status(500)
                              .send(
                                "Error inserting transaction journal entry line"
                              );
                          }

                          // Step 6: Determine debit/credit for payment method
                          let paymentDebitAmount = 0,
                            paymentCreditAmount = 0;
                          if (
                            ["asset", "expense"].includes(paymentAccountType)
                          ) {
                            paymentDebitAmount = 0;
                            paymentCreditAmount = amount;
                          } else {
                            paymentDebitAmount = amount;
                            paymentCreditAmount = 0;
                          }

                          // Step 7: Insert updated journal entry lines for payment method
                          db.run(
                            `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                            [
                              journal_entry_id,
                              payment_method_id,
                              paymentDebitAmount,
                              paymentCreditAmount,
                            ],
                            function (err) {
                              if (err) {
                                console.error(
                                  "Error inserting payment journal entry line:",
                                  err.message
                                );
                                return res
                                  .status(500)
                                  .send(
                                    "Error inserting payment journal entry line"
                                  );
                              }

                              // Step 8: Update the transaction record
                              db.run(
                                `UPDATE transactions SET transaction_date = ?, amount = ?, account_id = ?, description = ?, payment_method_id = ? WHERE id = ?`,
                                [
                                  transaction_date,
                                  amount,
                                  account_id,
                                  description,
                                  payment_method_id,
                                  transactionId,
                                ],
                                function (err) {
                                  if (err) {
                                    console.error(
                                      "Error updating transaction:",
                                      err.message
                                    );
                                    return res
                                      .status(500)
                                      .send("Error updating transaction");
                                  }

                                  res.status(200).json({
                                    message: "Transaction updated successfully",
                                    journal_entry_id: journal_entry_id,
                                  });
                                }
                              );
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

// ✅ 5. Delete a transaction
router.delete("/transactions/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM transactions WHERE id = ?", [id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ message: "Transaction not found" });
    }
    res.json({ message: "Transaction deleted successfully" });
  });
});
// ==================== CREATE PROCESS PAYMENT ====================

// ✅ 1. Get all payments
router.get("/processpayment", authenticateUser, (req, res) => {
  db.all(
    `SELECT p.*, a.account_name AS account_name, pm.account_name AS payment_method_name 
       FROM processpayments p
       JOIN chart_of_accounts a ON p.account_id = a.id
       JOIN chart_of_accounts pm ON p.payment_method_id = pm.id
       ORDER BY p.payment_date DESC`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// ✅ 2. Get a single payment by ID
router.get("/processpayment/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM payments WHERE id = ?", [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ message: "Payment not found" });
    }
    res.json(row);
  });
});
// ✅ 3. Create a new payment
router.post("/processpayment", authenticateUser, (req, res) => {
  const { payment_date, amount, account_id, payment_method_id, description } =
    req.body;

  const reference_number = `PAY-${Date.now()}`;
  const payment_description = description || "Payment processed";

  // Fetch account_id from payment_methods table
  db.get(
    `SELECT account_id FROM payment_methods WHERE id = ?`,
    [payment_method_id],
    (err, paymentMethod) => {
      if (err || !paymentMethod) {
        console.error(
          "Error fetching payment method account:",
          err?.message || "Payment method not found"
        );
        return res.status(500).send("Error fetching payment method account");
      }

      const actual_payment_method_id = paymentMethod.account_id; // Use this instead of the provided payment_method_id

      // Create journal entry
      db.run(
        `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, 'posted')`,
        [reference_number, payment_date, payment_description],
        function (err) {
          if (err) {
            console.error("Error creating journal entry:", err.message);
            return res.status(500).send("Error creating journal entry");
          }

          const journal_entry_id = this.lastID;

          // ✅ Insert Debit Entry (Account being paid)
          db.run(
            `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, 0)`,
            [journal_entry_id, account_id, amount],
            function (err) {
              if (err) {
                console.error(
                  "Error creating debit journal entry line:",
                  err.message
                );
                return res
                  .status(500)
                  .send("Error creating debit journal entry line");
              }

              // ✅ Insert Credit Entry (Payment method)
              db.run(
                `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, 0, ?)`,
                [journal_entry_id, actual_payment_method_id, amount],
                function (err) {
                  if (err) {
                    console.error(
                      "Error creating credit journal entry line:",
                      err.message
                    );
                    return res
                      .status(500)
                      .send("Error creating credit journal entry line");
                  }

                  // ✅ Insert into payments table
                  db.run(
                    `INSERT INTO processpayments (reference_number, payment_date, amount, account_id, payment_method_id, description, journal_entry_id) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                      reference_number,
                      payment_date,
                      amount,
                      account_id,
                      actual_payment_method_id,
                      description,
                      journal_entry_id,
                    ],
                    function (err) {
                      if (err) {
                        console.error("Error recording payment:", err.message);
                        return res.status(500).send("Error recording payment");
                      }

                      res.status(201).json({
                        message: "Payment processed successfully",
                        journal_entry_id: journal_entry_id,
                      });
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

// ✅ 4. Update a payment
// ✅ Update a payment
router.put("/processpayment/:id", authenticateUser, (req, res) => {
  const paymentId = req.params.id;
  const { payment_date, amount, account_id, payment_method_id, description } =
    req.body;

  db.get(
    `SELECT journal_entry_id FROM processpayments WHERE id = ?`,
    [paymentId],
    (err, payment) => {
      if (err || !payment) {
        console.error(
          "Payment not found:",
          err?.message || "Payment does not exist"
        );
        return res.status(404).send("Payment not found");
      }

      const journal_entry_id = payment.journal_entry_id;

      // Step 1: Update the journal entry
      db.run(
        `UPDATE journal_entries SET date = ?, description = ? WHERE id = ?`,
        [
          payment_date,
          description || "Updated payment entry",
          journal_entry_id,
        ],
        function (err) {
          if (err) {
            console.error("Error updating journal entry:", err.message);
            return res.status(500).send("Error updating journal entry");
          }

          // Step 2: Remove existing journal entry lines
          db.run(
            `DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`,
            [journal_entry_id],
            function (err) {
              if (err) {
                console.error(
                  "Error deleting journal entry lines:",
                  err.message
                );
                return res
                  .status(500)
                  .send("Error deleting journal entry lines");
              }

              // Step 3: Fetch account_id from payment_methods
              db.get(
                `SELECT account_id FROM payment_methods WHERE id = ?`,
                [payment_method_id],
                (err, paymentMethod) => {
                  if (err || !paymentMethod) {
                    console.error(
                      "Error fetching payment method account:",
                      err?.message || "Payment method not found"
                    );
                    return res
                      .status(500)
                      .send("Error fetching payment method account");
                  }

                  const actual_payment_account_id = paymentMethod.account_id;

                  // Step 4: Reinsert new journal entry lines with updated data
                  db.run(
                    `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                    [journal_entry_id, account_id, amount, 0], // Debit the liability
                    function (err) {
                      if (err) {
                        return res
                          .status(500)
                          .send(
                            "Error updating transaction journal entry line"
                          );
                      }

                      db.run(
                        `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                        [
                          journal_entry_id,
                          actual_payment_account_id,
                          0,
                          amount,
                        ], // Credit the asset (Fetched account ID)
                        function (err) {
                          if (err) {
                            return res
                              .status(500)
                              .send(
                                "Error updating payment journal entry line"
                              );
                          }

                          // Step 5: Update the processpayments table
                          db.run(
                            `UPDATE processpayments SET payment_date = ?, amount = ?, account_id = ?, payment_method_id = ?, description = ? WHERE id = ?`,
                            [
                              payment_date,
                              amount,
                              account_id,
                              actual_payment_account_id,
                              description,
                              paymentId,
                            ],
                            function (err) {
                              if (err) {
                                return res
                                  .status(500)
                                  .send("Error updating payment");
                              }

                              res.status(200).json({
                                message: "Payment updated successfully",
                              });
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

// ✅ 5. Delete a payment
router.delete("/processpayment/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM processpayments WHERE id = ?", [id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }
    res.json({ message: "Payment deleted successfully" });
  });
});
// ==================== CREATE EXPENSE ====================
router.post("/expenses", authenticateUser, (req, res) => {
  const {
    expense_date,
    amount,
    expense_account_id,
    description,
    payment_method_id,
    payment_method,
  } = req.body;

  // Step 1: Create a journal entry for the expense
  const reference_number = `EXP${Date.now()}`;
  const journal_entry_description = description || "Expense entry";

  db.run(
    `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, 'posted')`,
    [reference_number, expense_date, journal_entry_description],
    function (err) {
      if (err) {
        console.error("Error creating journal entry:", err.message);
        return res.status(500).send("Error creating journal entry");
      }

      const journal_entry_id = this.lastID;

      // Step 2: Debit the expense account
      db.run(
        `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
        [journal_entry_id, expense_account_id, amount, 0],
        function (err) {
          if (err) {
            console.error("Error creating journal entry line:", err.message);
            return res.status(500).send("Error creating journal entry line");
          }

          if (payment_method === "credit") {
            // Step 3: Credit "Accounts Payable" for credit expenses
            const accountsPayableId = 5; // Assuming Account ID 5 is "Accounts Payable"
            db.run(
              `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
              [journal_entry_id, accountsPayableId, 0, amount],
              function (err) {
                if (err) {
                  console.error(
                    "Error creating Accounts Payable journal entry line:",
                    err.message
                  );
                  return res
                    .status(500)
                    .send("Error creating Accounts Payable journal entry line");
                }

                // Step 4: Create the expense record
                createExpenseRecord(
                  expense_date,
                  amount,
                  expense_account_id,
                  description,
                  journal_entry_id,
                  payment_method,
                  res
                );
              }
            );
          } else {
            // Step 3: Fetch account_id from payment_methods for non-credit payments
            db.get(
              `SELECT account_id FROM payment_methods WHERE id = ?`,
              [payment_method_id],
              (err, paymentMethod) => {
                if (err || !paymentMethod) {
                  console.error(
                    "Error fetching payment method account:",
                    err?.message || "Payment method not found"
                  );
                  return res
                    .status(500)
                    .send("Error fetching payment method account");
                }

                const actual_payment_account_id = paymentMethod.account_id;

                // Step 4: Credit the fetched payment account
                db.run(
                  `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                  [journal_entry_id, actual_payment_account_id, 0, amount],
                  function (err) {
                    if (err) {
                      console.error(
                        "Error creating payment method journal entry line:",
                        err.message
                      );
                      return res
                        .status(500)
                        .send(
                          "Error creating payment method journal entry line"
                        );
                    }

                    // Step 5: Create the expense record
                    createExpenseRecord(
                      expense_date,
                      amount,
                      expense_account_id,
                      description,
                      journal_entry_id,
                      actual_payment_account_id,
                      res
                    );
                  }
                );
              }
            );
          }
        }
      );
    }
  );
});

function createExpenseRecord(
  expense_date,
  amount,
  expense_account_id,
  description,
  journal_entry_id,
  payment_method, // <-- Added payment_method
  res
) {
  db.run(
    `INSERT INTO expenses (expense_date, amount, expense_account_id, description, journal_entry_id) 
       VALUES (?, ?, ?, ?, ?)`,
    [expense_date, amount, expense_account_id, description, journal_entry_id],
    function (err) {
      if (err) {
        console.error("Error creating expense:", err.message);
        return res.status(500).send("Error creating expense");
      }

      const expense_id = this.lastID; // Get the inserted expense ID
      createExpenseInvoice(expense_id, amount, payment_method, res); // <-- Pass payment_method
    }
  );
}

// Function to create the expense invoice
function createExpenseInvoice(expense_id, total_amount, payment_method, res) {
  const reference_number = `EXP-INV-${Date.now()}`;
  const issue_date = new Date().toISOString().split("T")[0];

  // Determine invoice status based on payment method
  const status = payment_method === "credit" ? "unpaid" : "paid";

  db.run(
    `INSERT INTO expense_invoices (expense_id, reference_number, issue_date, total_amount, amount_paid, status) 
       VALUES (?, ?, ?, ?, ?, ?)`,
    [
      expense_id,
      reference_number,
      issue_date,
      total_amount,
      status === "paid" ? total_amount : 0,
      status,
    ], // <-- Set amount_paid if paid
    function (err) {
      if (err) {
        console.error("Error creating expense invoice:", err.message);
        return res.status(500).send("Error creating expense invoice");
      }

      res.status(201).json({
        message: "Expense and Invoice created successfully",
        expense_id: expense_id,
        invoice_id: this.lastID,
        invoice_status: status,
      });
    }
  );
}

// ==================== READ EXPENSES ====================
router.get("/expenses", authenticateUser, (req, res) => {
  const query = `
      SELECT e.*, ei.status, ei.balance_due
      FROM expenses e
      LEFT JOIN expense_invoices ei ON e.id = ei.id
    `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error("Error fetching expenses:", err.message);
      return res.status(500).send("Error fetching expenses");
    }

    res.json(rows);
  });
});

// ==================== READ SINGLE EXPENSE ====================
router.get("/expenses/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const query = `SELECT * FROM expenses WHERE id = ?`;

  db.get(query, [id], (err, row) => {
    if (err) {
      console.error("Error fetching expense:", err.message);
      return res.status(500).send("Error fetching expense");
    }

    if (!row) {
      return res.status(404).send("Expense not found");
    }

    res.json(row);
  });
});

router.put("/expenses/pay/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { payment_method_id, payAmount } = req.body;

  // Fetch expense details
  db.get(
    `SELECT e.*, ei.id AS invoice_id, ei.total_amount, ei.amount_paid, ei.balance_due
       FROM expenses e
       LEFT JOIN expense_invoices ei ON e.id = ei.id
       WHERE e.id = ?`,
    [id],
    (err, expense) => {
      if (err) {
        console.error("Error fetching expense:", err.message);
        return res.status(500).send("Error fetching expense");
      }
      if (!expense) {
        return res.status(404).send("Expense not found");
      }

      // Ensure payment amount does not exceed balance due
      if (payAmount > expense.balance_due) {
        return res.status(400).send("Payment amount exceeds balance due");
      }

      // Step 1: Create a new Journal Entry for the payment
      const reference_number = `PAY${Date.now()}`;
      const date = new Date().toISOString().split("T")[0];
      const journal_entry_description = `Payment for Expense #${id}`;

      db.run(
        `INSERT INTO journal_entries (reference_number, date, description, status) 
           VALUES (?, ?, ?, 'posted')`,
        [reference_number, date, journal_entry_description],
        function (err) {
          if (err) {
            console.error("Error creating payment journal entry:", err.message);
            return res.status(500).send("Error creating journal entry");
          }

          const journal_entry_id = this.lastID;

          // Step 2: Create Journal Entry Lines
          const paymentAccountId = payment_method_id; // Cash/Bank Account
          const accountsPayableId = 5; // Replace with actual "Accounts Payable" account ID

          // Debit: Reduce cash/bank balance
          db.run(
            `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) 
               VALUES (?, ?, ?, ?)`,
            [journal_entry_id, paymentAccountId, 0, payAmount],
            function (err) {
              if (err) {
                console.error(
                  "Error creating debit journal entry line:",
                  err.message
                );
                return res
                  .status(500)
                  .send("Error creating journal entry line");
              }

              // Credit: Reduce liability
              db.run(
                `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) 
                   VALUES (?, ?, ?, ?)`,
                [journal_entry_id, accountsPayableId, payAmount, 0],
                function (err) {
                  if (err) {
                    console.error(
                      "Error creating credit journal entry line:",
                      err.message
                    );
                    return res
                      .status(500)
                      .send("Error creating journal entry line");
                  }

                  // Step 3: Update Payment Records
                  const newAmountPaid =
                    parseFloat(expense.amount_paid) + parseFloat(payAmount);

                  const newBalanceDue =
                    parseFloat(expense.total_amount) -
                    parseFloat(newAmountPaid);
                  const newStatus = newBalanceDue === 0 ? "paid" : "partial";

                  db.run(
                    `UPDATE expense_invoices 
                       SET amount_paid = ?, status = ? 
                       WHERE id = ?`,
                    [newAmountPaid, newStatus, expense.invoice_id],
                    function (err) {
                      if (err) {
                        console.error(
                          "Error updating expense status:",
                          err.message
                        );
                        return res
                          .status(500)
                          .send("Error updating expense status");
                      }

                      res.status(200).json({
                        message: `Expense marked as ${newStatus}, journal entry created successfully!`,
                      });
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});
// ==================== UPDATE EXPENSE ====================
router.put("/expenses/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const {
    expense_date,
    amount,
    expense_account_id,
    payment_method,
    payment_method_id,
    description,
  } = req.body;
  // Step 1: Get journal_entry_id associated with the expense
  db.get(
    `SELECT journal_entry_id, id AS invoice_id FROM expenses WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error("Error fetching journal entry ID:", err.message);
        return res.status(500).send("Error fetching journal entry ID");
      }

      if (!row) {
        return res.status(404).send("Expense not found");
      }

      const journal_entry_id = row.journal_entry_id;
      const invoice_id = row.invoice_id;

      // Step 2: Update the journal entry (date, description)
      db.run(
        `UPDATE journal_entries SET date = ?, description = ? WHERE id = ?`,
        [expense_date, description, journal_entry_id],
        function (err) {
          if (err) {
            console.error("Error updating journal entry:", err.message);
            return res.status(500).send("Error updating journal entry");
          }

          // Step 3: Update journal entry lines (debit & credit)
          updateJournalEntryLines(
            journal_entry_id,
            expense_account_id,
            amount,
            payment_method,
            payment_method_id,
            res,
            () => {
              // Step 4: Update the expense record
              db.run(
                `UPDATE expenses 
                   SET expense_date = ?, amount = ?, expense_account_id = ?, payment_method = ?, description = ? 
                   WHERE id = ?`,
                [
                  expense_date,
                  amount,
                  expense_account_id,
                  payment_method,
                  description,
                  id,
                ],
                function (err) {
                  if (err) {
                    console.error("Error updating expense:", err.message);
                    return res.status(500).send("Error updating expense");
                  }

                  // Step 5: Update the expense invoice (if applicable)
                  updateExpenseInvoice(invoice_id, amount, res, () => {
                    res
                      .status(200)
                      .json({ message: "Expense updated successfully" });
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

// Function to update journal entry lines
function updateJournalEntryLines(
  journal_entry_id,
  expense_account_id,
  amount,
  payment_method,
  payment_method_id,
  res,
  callback
) {
  db.serialize(() => {
    // Update Debit Entry (Expense Account)
    db.run(
      `UPDATE journal_entry_lines 
         SET account_id = ?, debit = ?, credit = 0 
         WHERE journal_entry_id = ? AND debit > 0`,
      [expense_account_id, amount, journal_entry_id],
      function (err) {
        if (err) {
          console.error(
            "Error updating expense journal entry line:",
            err.message
          );
          return res
            .status(500)
            .send("Error updating expense journal entry line");
        }

        // Update Credit Entry (Payment Method or Accounts Payable)
        const creditAccountId =
          payment_method === "credit" ? 5 : payment_method_id; // 5 = Accounts Payable
        db.run(
          `UPDATE journal_entry_lines 
             SET account_id = ?, debit = 0, credit = ? 
             WHERE journal_entry_id = ? AND credit > 0`,
          [creditAccountId, amount, journal_entry_id],
          function (err) {
            if (err) {
              console.error(
                "Error updating payment journal entry line:",
                err.message
              );
              return res
                .status(500)
                .send("Error updating payment journal entry line");
            }

            callback(); // Proceed with updating expense record
          }
        );
      }
    );
  });
}

// Function to update the expense_invoice
function updateExpenseInvoice(invoice_id, amount, res, callback) {
  // Fetch current invoice data
  db.get(
    `SELECT total_amount, amount_paid, balance_due FROM expense_invoices WHERE expense_id = ?`,
    [invoice_id],
    (err, invoice) => {
      if (err) {
        console.error("Error fetching expense invoice:", err.message);
        return res.status(500).send("Error fetching expense invoice");
      }

      if (!invoice) {
        return res.status(404).send("Invoice not found");
      }
      // Update invoice with new amount_paid and balance_due
      db.run(
        `UPDATE expense_invoices
           SET total_amount = ?
           WHERE expense_id = ?`,
        [amount, invoice_id],
        function (err) {
          if (err) {
            console.error("Error updating expense invoice:", err.message);
            return res.status(500).send("Error updating expense invoice");
          }

          callback(); // Proceed with final response
        }
      );
    }
  );
}

router.patch("/expenses/payment/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { payment_method_id, amount } = req.body;

  // Step 1: Update the journal entry's status to "posted"
  const updateJournalStatusQuery = `
      UPDATE journal_entries 
      SET status = 'posted' 
      WHERE id = (SELECT journal_entry_id FROM expenses WHERE id = ?)
    `;

  db.run(updateJournalStatusQuery, [id], function (err) {
    if (err) {
      console.error("Error updating journal status:", err.message);
      return res.status(500).send("Error updating journal status");
    }

    // Step 2: Insert debit and credit lines for the payment
    // 2.1: Get the expense details (expense account id, payment method account id)
    const getExpenseDetailsQuery = `
        SELECT expense_account_id, payment_method FROM expenses WHERE id = ?
      `;

    db.get(getExpenseDetailsQuery, [id], (err, row) => {
      if (err) {
        console.error("Error fetching expense details:", err.message);
        return res.status(500).send("Error fetching expense details");
      }

      const { expense_account_id, payment_method } = row;

      // Step 2.2: Create the debit and credit journal entries for the payment
      const insertDebitQuery = `
          INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
          VALUES ((SELECT journal_entry_id FROM expenses WHERE id = ?), ?, ?, 0)
        `;

      const insertCreditQuery = `
          INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
          VALUES ((SELECT journal_entry_id FROM expenses WHERE id = ?), ?, 0, ?)
        `;

      // Debit the expense account
      db.run(
        insertDebitQuery,
        [id, expense_account_id, amount],
        function (err) {
          if (err) {
            console.error("Error inserting debit journal line:", err.message);
            return res.status(500).send("Error inserting debit journal line");
          }

          // Credit the payment method account
          db.run(
            insertCreditQuery,
            [id, payment_method, amount],
            function (err) {
              if (err) {
                console.error(
                  "Error inserting credit journal line:",
                  err.message
                );
                return res
                  .status(500)
                  .send("Error inserting credit journal line");
              }

              res.status(200).json({
                message: "Payment recorded successfully and journal updated",
              });
            }
          );
        }
      );
    });
  });
});

// ==================== DELETE EXPENSE ====================
router.delete("/expenses/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  // Step 1: Get journal entry ID for the expense
  db.get(
    `SELECT journal_entry_id FROM expenses WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error("Error fetching journal entry ID:", err.message);
        return res.status(500).send("Error fetching journal entry ID");
      }

      if (!row) {
        return res.status(404).send("Expense not found");
      }

      const journal_entry_id = row.journal_entry_id;
      const reversal_reference = `REV${Date.now()}`;
      const reversal_date = new Date().toISOString().split("T")[0];

      // Step 2: Fetch existing journal entry lines
      db.all(
        `SELECT account_id, debit, credit FROM journal_entry_lines WHERE journal_entry_id = ?`,
        [journal_entry_id],
        (err, lines) => {
          if (err) {
            console.error("Error fetching journal entry lines:", err.message);
            return res.status(500).send("Error fetching journal entry lines");
          }

          if (!lines || lines.length === 0) {
            return res
              .status(404)
              .send("No journal entry lines found for expense.");
          }

          // Step 3: Insert a new reversing journal entry
          db.run(
            `INSERT INTO journal_entries (reference_number, date, description, status) VALUES (?, ?, ?, 'posted')`,
            [reversal_reference, reversal_date, `Reversal for Expense #${id}`],
            function (err) {
              if (err) {
                console.error(
                  "Error creating reversing journal entry:",
                  err.message
                );
                return res
                  .status(500)
                  .send("Error creating reversing journal entry");
              }

              const reversal_entry_id = this.lastID;

              // Step 4: Insert reversing journal entry lines
              let insertQueries = lines.map((line) => {
                return new Promise((resolve, reject) => {
                  db.run(
                    `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)`,
                    [
                      reversal_entry_id,
                      line.account_id,
                      line.credit,
                      line.debit,
                    ], // Reversing debit & credit
                    function (err) {
                      if (err) {
                        console.error(
                          "Error inserting reversing journal entry line:",
                          err.message
                        );
                        reject(err);
                      } else {
                        resolve();
                      }
                    }
                  );
                });
              });

              Promise.all(insertQueries)
                .then(() => {
                  // Step 5: Proceed with deleting original journal entry and expense
                  deleteExpenseAndInvoice(journal_entry_id, id, res);
                })
                .catch((err) => {
                  console.error(
                    "Error inserting reversing journal entry lines:",
                    err.message
                  );
                  res
                    .status(500)
                    .send("Error inserting reversing journal entry lines");
                });
            }
          );
        }
      );
    }
  );
});

// Function to delete the journal entry, invoice, and expense
function deleteExpenseAndInvoice(journal_entry_id, expense_id, res) {
  db.serialize(() => {
    // Delete Journal Entry Lines
    db.run(
      `DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`,
      [journal_entry_id],
      function (err) {
        if (err) {
          console.error("Error deleting journal entry lines:", err.message);
          return res.status(500).send("Error deleting journal entry lines");
        }

        // Delete Journal Entry
        db.run(
          `DELETE FROM journal_entries WHERE id = ?`,
          [journal_entry_id],
          function (err) {
            if (err) {
              console.error("Error deleting journal entry:", err.message);
              return res.status(500).send("Error deleting journal entry");
            }

            // Delete Expense Invoice
            db.run(
              `DELETE FROM expense_invoices WHERE id = ?`,
              [expense_id],
              function (err) {
                if (err) {
                  console.error("Error deleting expense invoice:", err.message);
                  return res.status(500).send("Error deleting expense invoice");
                }

                // Delete Expense Record
                db.run(
                  `DELETE FROM expenses WHERE id = ?`,
                  [expense_id],
                  function (err) {
                    if (err) {
                      console.error("Error deleting expense:", err.message);
                      return res.status(500).send("Error deleting expense");
                    }

                    res.status(200).json({
                      message:
                        "Expense deleted successfully, and reversal entry recorded.",
                    });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
}

// 🔹 Get All Invoices
router.get("/expense-invoices", authenticateUser, (req, res) => {
  db.all("SELECT * FROM expense_invoices", [], (err, rows) => {
    if (err) {
      console.error("Error fetching invoices:", err.message);
      return res.status(500).json({ error: "Failed to fetch invoices" });
    }
    res.json(rows);
  });
});


// 🔹 Get Single Invoice by ID
router.get("/expense-invoices/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM expense_invoices WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error("Error fetching invoice:", err.message);
      return res.status(500).json({ error: "Failed to fetch invoice" });
    }
    if (!row) return res.status(404).json({ error: "Invoice not found" });
    res.json(row);
  });
});

// 🔹 Create New Invoice
router.post("/expense-invoices", authenticateUser, (req, res) => {
  const { expense_id, total_amount } = req.body;
  if (!expense_id || !total_amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const reference_number = `EXP${Date.now()}`;
  const issue_date = new Date().toISOString().split("T")[0];

  db.run(
    `INSERT INTO expense_invoices (expense_id, reference_number, issue_date, total_amount, amount_paid, status) 
       VALUES (?, ?, ?, ?, 0, 'unpaid')`,
    [expense_id, reference_number, issue_date, total_amount],
    function (err) {
      if (err) {
        console.error("Error creating invoice:", err.message);
        return res.status(500).json({ error: "Failed to create invoice" });
      }
      res.status(201).json({ message: "Invoice created", id: this.lastID });
    }
  );
});

// 🔹 Update Invoice (Payment)
router.put("/expense-invoices/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  const { amount_paid } = req.body;

  if (amount_paid === undefined) {
    return res.status(400).json({ error: "Amount paid is required" });
  }

  db.run(
    `UPDATE expense_invoices 
       SET amount_paid = ?, 
           status = CASE 
                      WHEN total_amount = amount_paid THEN 'paid'
                      WHEN amount_paid > 0 THEN 'partial'
                      ELSE 'unpaid'
                    END
       WHERE id = ?`,
    [amount_paid, id],
    function (err) {
      if (err) {
        console.error("Error updating invoice:", err.message);
        return res.status(500).json({ error: "Failed to update invoice" });
      }
      res.json({ message: "Invoice updated successfully" });
    }
  );
});

// 🔹 Delete Invoice
router.delete("/expense-invoices/:id", authenticateUser, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM expense_invoices WHERE id = ?", [id], function (err) {
    if (err) {
      console.error("Error deleting invoice:", err.message);
      return res.status(500).json({ error: "Failed to delete invoice" });
    }
    res.json({ message: "Invoice deleted successfully" });
  });
});

router.get("/reports/income-statement", authenticateUser, (req, res) => {
  const { from_date, to_date } = req.query;

  if (!from_date || !to_date) {
    return res.status(400).send("Both from_date and to_date are required.");
  }

  try {
    const revenueQuery = `
      SELECT 
        COALESCE(coa.parent_account_id, coa.id) AS display_id,
        COALESCE(parent.account_name, coa.account_name) AS account_name,
        SUM(jel.credit - jel.debit) AS amount
      FROM journal_entries je
      INNER JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id
      INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
      LEFT JOIN chart_of_accounts parent ON coa.parent_account_id = parent.id
      WHERE coa.account_type = 'revenue'
        AND je.date BETWEEN ? AND ?
      GROUP BY display_id;
    `;

    const expenseQuery = `
      SELECT 
        COALESCE(coa.parent_account_id, coa.id) AS display_id,
        COALESCE(parent.account_name, coa.account_name) AS account_name,
        SUM(jel.debit - jel.credit) AS amount
      FROM journal_entries je
      INNER JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id
      INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
      LEFT JOIN chart_of_accounts parent ON coa.parent_account_id = parent.id
      WHERE coa.account_type = 'expense'
        AND je.date BETWEEN ? AND ?
      GROUP BY display_id;
    `;

    db.all(revenueQuery, [from_date, to_date], (err, revenue) => {
      if (err) {
        console.error("Error fetching revenue data:", err);
        return res.status(500).send("Failed to fetch revenue data.");
      }

      db.all(expenseQuery, [from_date, to_date], (err, expenses) => {
        if (err) {
          console.error("Error fetching expense data:", err);
          return res.status(500).send("Failed to fetch expense data.");
        }

        const totalRevenue = revenue.reduce(
          (sum, item) => sum + (item.amount || 0),
          0
        );
        const totalExpenses = expenses.reduce(
          (sum, item) => sum + (item.amount || 0),
          0
        );
        const netIncome = totalRevenue - totalExpenses;

        res.json({
          revenue,
          expenses,
          totalRevenue,
          totalExpenses,
          netIncome,
        });
      });
    });
  } catch (error) {
    console.error("Error generating income statement:", error.message);
    res.status(500).send("Failed to generate income statement.");
  }
});


router.get("/reports/balance-sheet", authenticateUser, async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ error: "Date is required." });
  }

  const dateFormatted = new Date(date).toISOString().split("T")[0];

  try {
    const queries = {
      currentAssets: `
        SELECT 
          COALESCE(coa.parent_account_id, coa.id) AS display_id,
          (
            SELECT account_name 
            FROM chart_of_accounts 
            WHERE id = COALESCE(coa.parent_account_id, coa.id)
          ) AS account_name,
          SUM(jel.debit - jel.credit) AS amount
        FROM journal_entry_lines jel
        INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
        INNER JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE 
          coa.account_type = 'asset' 
          AND coa.is_current = TRUE
          AND je.date <= ?
        GROUP BY display_id;
      `,
      nonCurrentAssets: `
        SELECT 
          COALESCE(coa.parent_account_id, coa.id) AS display_id,
          (
            SELECT account_name 
            FROM chart_of_accounts 
            WHERE id = COALESCE(coa.parent_account_id, coa.id)
          ) AS account_name,
          SUM(jel.debit - jel.credit) AS amount
        FROM journal_entry_lines jel
        INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
        INNER JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE 
          coa.account_type = 'asset' 
          AND coa.is_current = FALSE
          AND je.date <= ?
        GROUP BY display_id;
      `,
      currentLiabilities: `
        SELECT 
          COALESCE(coa.parent_account_id, coa.id) AS display_id,
          (
            SELECT account_name 
            FROM chart_of_accounts 
            WHERE id = COALESCE(coa.parent_account_id, coa.id)
          ) AS account_name,
          SUM(jel.credit - jel.debit) AS amount
        FROM journal_entry_lines jel
        INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
        INNER JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE 
          coa.account_type = 'liability' 
          AND coa.is_current = TRUE
          AND je.date <= ?
        GROUP BY display_id;
      `,
      nonCurrentLiabilities: `
        SELECT 
          COALESCE(coa.parent_account_id, coa.id) AS display_id,
          (
            SELECT account_name 
            FROM chart_of_accounts 
            WHERE id = COALESCE(coa.parent_account_id, coa.id)
          ) AS account_name,
          SUM(jel.credit - jel.debit) AS amount
        FROM journal_entry_lines jel
        INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
        INNER JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE 
          coa.account_type = 'liability' 
          AND coa.is_current = FALSE
          AND je.date <= ?
        GROUP BY display_id;
      `,
      equity: `
        SELECT 
          COALESCE(coa.parent_account_id, coa.id) AS display_id,
          (
            SELECT account_name 
            FROM chart_of_accounts 
            WHERE id = COALESCE(coa.parent_account_id, coa.id)
          ) AS account_name,
          SUM(jel.credit - jel.debit) AS amount
        FROM journal_entry_lines jel
        INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
        INNER JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE 
          coa.account_type = 'equity'
          AND je.date <= ?
        GROUP BY display_id;
      `,
      revenue: `
        SELECT SUM(jel.credit - jel.debit) AS total_revenue
        FROM journal_entry_lines jel
        INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
        INNER JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE 
          coa.account_type = 'revenue'
          AND je.date <= ?;
      `,
      expense: `
        SELECT SUM(jel.debit - jel.credit) AS total_expense
        FROM journal_entry_lines jel
        INNER JOIN chart_of_accounts coa ON jel.account_id = coa.id
        INNER JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE 
          coa.account_type = 'expense'
          AND je.date <= ?;
      `,
    };

    const results = await Promise.all(
      Object.entries(queries).map(([key, query]) =>
        new Promise((resolve, reject) => {
          db.all(query, [dateFormatted], (err, rows) => {
            if (err) {
              console.error(`Error in ${key} query:`, err.message);
              reject(err);
            }
            resolve({ key, rows });
          });
        })
      )
    );

    const data = Object.fromEntries(
      results.map(({ key, rows }) => [key, rows])
    );

    const totalRevenue = data.revenue[0]?.total_revenue || 0;
    const totalExpense = data.expense[0]?.total_expense || 0;
    const netProfit = totalRevenue - totalExpense;

    data.equity.push({
      account_name: "Net Income",
      amount: netProfit,
    });

    res.json(data);
  } catch (error) {
    console.error("Error generating balance sheet:", error.message);
    res.status(500).json({ error: "Failed to generate balance sheet." });
  }
});

router.get("/reports/trial-balance", authenticateUser, (req, res) => {
    try {
        const { from_date, to_date } = req.query;
       
        let query = `
        SELECT
            c.id,
            c.account_name,
            c.parent_account_id,
            SUM(CASE WHEN je.date <= ? THEN jel.debit ELSE 0 END) AS debit,
            SUM(CASE WHEN je.date <= ? THEN jel.credit ELSE 0 END) AS credit
        FROM
            chart_of_accounts c
        LEFT JOIN
            journal_entry_lines jel ON jel.account_id = c.id
        LEFT JOIN
            journal_entries je ON jel.journal_entry_id = je.id
        WHERE
            c.account_type != 'adjustment'
        `;
       
        const params = [];
       
        // For trial balance, we need cumulative balance up to to_date
        // If to_date is provided, use it; otherwise use a far future date
        const effectiveToDate = to_date || '9999-12-31';
        params.push(effectiveToDate, effectiveToDate);
       
        query += `
        GROUP BY
            c.id, c.account_name, c.parent_account_id
        ORDER BY
            COALESCE(c.parent_account_id, c.id), c.id;
        `;
       
        db.all(query, params, (err, rows) => {
            if (err) {
                console.error("Error fetching trial balance:", err.message);
                return res.status(500).send("Error fetching trial balance.");
            }
           
            res.json(rows);
        });
    } catch (error) {
        console.error("Error generating trial balance:", error.message);
        res.status(500).send("Failed to generate trial balance.");
    }
});

// API endpoint to fetch ledger with balances

router.get("/ledger", authenticateUser, (req, res) => {
  const { accountId, startDate, endDate } = req.query;

  if (!accountId || !startDate || !endDate) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  // Step 1: Check if the account is a parent and get all related accounts
  const parentQuery = `
    SELECT id, account_type, account_name FROM chart_of_accounts 
    WHERE parent_account_id = ? OR id = ?;
  `;

  db.all(parentQuery, [accountId, accountId], (err, accounts) => {
    if (err) {
      console.error("Error checking parent account:", err.message);
      return res.status(500).json({ error: "Database query failed" });
    }

    if (!accounts || accounts.length === 0) {
      return res.status(404).json({ error: "Account not found" });
    }

    // Extract all related account IDs and get account info
    const accountIds = accounts.map((acc) => acc.id);
    const mainAccount = accounts.find(acc => acc.id == accountId);
    const accountType = mainAccount?.account_type;
    const accountName = mainAccount?.account_name;

    // Step 2: Calculate OPENING BALANCE (balance before startDate)
    const openingBalanceQuery = `
      SELECT 
        SUM(CASE WHEN ? IN ('Asset', 'Expense') 
          THEN (jel.debit - jel.credit)
          ELSE (jel.credit - jel.debit)
        END) as net_balance,
        SUM(jel.debit) as total_debit,
        SUM(jel.credit) as total_credit
      FROM journal_entry_lines jel
      JOIN journal_entries je ON jel.journal_entry_id = je.id
      WHERE jel.account_id IN (${accountIds.join(",")})
      AND DATE(je.date) < DATE(?);
    `;

    db.get(openingBalanceQuery, [accountType, startDate], (err, result) => {
      if (err) {
        console.error("Error calculating opening balance:", err.message);
        return res.status(500).json({ error: "Database query failed" });
      }

      // For expense accounts, typically no opening balance
      // But we'll show it for completeness in the current period
      const netBalance = result?.net_balance || 0;
      const totalDebit = result?.total_debit || 0;
      const totalCredit = result?.total_credit || 0;
      
      // Determine if it's a debit or credit balance
      let openingDebit = 0;
      let openingCredit = 0;
      
      if (accountType === 'Asset' || accountType === 'Expense') {
        // Debit balance accounts
        openingDebit = netBalance > 0 ? Math.abs(netBalance) : 0;
        openingCredit = netBalance < 0 ? Math.abs(netBalance) : 0;
      } else {
        // Credit balance accounts (Liability, Equity, Revenue)
        openingCredit = netBalance > 0 ? Math.abs(netBalance) : 0;
        openingDebit = netBalance < 0 ? Math.abs(netBalance) : 0;
      }

      // Step 3: Fetch transactions within date range
      const query = `
        SELECT 
          je.id,
          je.date, 
          je.description, 
          jel.debit, 
          jel.credit,
          jel.account_id
        FROM journal_entry_lines jel
        JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE jel.account_id IN (${accountIds.join(",")})
        AND DATE(je.date) BETWEEN DATE(?) AND DATE(?)
        ORDER BY je.date ASC, je.id ASC;
      `;

      db.all(query, [startDate, endDate], (err, rows) => {
        if (err) {
          console.error("Error fetching ledger transactions:", err.message);
          return res.status(500).json({ error: "Database query failed" });
        }

        // Calculate running totals properly
        let runningDebit = openingDebit;
        let runningCredit = openingCredit;
        let runningBalance = netBalance;
        
        // Always include opening balance as first entry if non-zero
        const transactionsWithBalance = [];
        
        // Only add opening balance entry if there's actually a balance
        // For expense accounts in a new period, this might be empty
        if (openingDebit > 0 || openingCredit > 0) {
          transactionsWithBalance.push({
            id: null,
            date: startDate,
            description: "Balance Brought Forward",
            debit: parseFloat(openingDebit.toFixed(2)),
            credit: parseFloat(openingCredit.toFixed(2)),
            account_id: accountId,
            balance: parseFloat(runningBalance.toFixed(2)),
            is_opening_balance: true
          });
        }

        // Add all transactions from the period
        rows.forEach((row) => {
          // Update running totals
          runningDebit += (row.debit || 0);
          runningCredit += (row.credit || 0);
          
          // Update net running balance based on account type
          if (accountType === 'Asset' || accountType === 'Expense') {
            runningBalance += (row.debit || 0) - (row.credit || 0);
          } else {
            runningBalance += (row.credit || 0) - (row.debit || 0);
          }
          
          transactionsWithBalance.push({ 
            ...row, 
            balance: parseFloat(runningBalance.toFixed(2))
          });
        });

        // Return metadata along with transactions
        res.json({
          account_id: accountId,
          account_name: accountName,
          account_type: accountType,
          start_date: startDate,
          end_date: endDate,
          opening_debit: parseFloat(openingDebit.toFixed(2)),
          opening_credit: parseFloat(openingCredit.toFixed(2)),
          opening_balance: parseFloat(netBalance.toFixed(2)),
          closing_debit: parseFloat(runningDebit.toFixed(2)),
          closing_credit: parseFloat(runningCredit.toFixed(2)),
          closing_balance: parseFloat(runningBalance.toFixed(2)),
          transactions: transactionsWithBalance
        });
      });
    });
  });
});

router.get("/chart-of-accounts", authenticateUser, (req, res) => {
  try {
    const query = `
        WITH RECURSIVE AccountHierarchy AS (
          -- Base case: Start with all accounts
          SELECT 
            coa.id,
            coa.account_name,
            coa.account_code,
            coa.account_type,
            coa.parent_account_id,
            SUM(jel.debit) AS total_debit,
            SUM(jel.credit) AS total_credit
          FROM chart_of_accounts coa
          LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
          GROUP BY coa.id
  
          UNION ALL
  
          -- Recursive case: Add child accounts to their parent
          SELECT 
            parent.id,
            parent.account_name,
            parent.account_code,
            parent.account_type,
            parent.parent_account_id,
            child.total_debit,
            child.total_credit
          FROM AccountHierarchy child
          JOIN chart_of_accounts parent ON child.parent_account_id = parent.id
        )
        SELECT 
          id,
          account_name,
          account_code,
          account_type,
          parent_account_id,
          SUM(total_debit) AS total_debit,
          SUM(total_credit) AS total_credit
        FROM AccountHierarchy
        GROUP BY id, account_name, account_code, account_type, parent_account_id
        ORDER BY COALESCE(parent_account_id, id), id;
      `;

    db.all(query, [], (err, accounts) => {
      if (err) {
        console.error(
          "Error fetching chart of accounts with balances:",
          err.message
        );
        return res.status(500).send("Error fetching chart of accounts.");
      }

      // Adjust balance calculation based on account type
      const accountsWithBalances = accounts.map((account) => {
        let balance = 0;

        // Adjust balance calculation based on account type
        switch (account.account_type) {
          case "asset":
          case "expense":
            balance = account.total_debit - account.total_credit;
            break;
          case "liability":
          case "revenue":
          case "equity": // Added equity handling
            balance = account.total_credit - account.total_debit;
            break;
          default:
            balance = 0;
        }

        return { ...account, balance };
      });

      res.json(accountsWithBalances);
    });
  } catch (error) {
    console.error(
      "Error fetching chart of accounts with balances:",
      error.message
    );
    res.status(500).send("Failed to fetch chart of accounts.");
  }
});


// ===================== Journal Entry =====================
// ✅ Get all journal entries
router.get("/journal_entry", (req, res) => {
  const sql = "SELECT * FROM journal_entries ORDER BY date DESC";
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ✅ Get a specific journal entry and its lines
router.get("/journal_entry/:id", (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM journal_entries WHERE id = ?", [id], (err, entry) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!entry) return res.status(404).json({ message: "Entry not found" });

    db.all(
      "SELECT * FROM journal_entry_lines WHERE journal_entry_id = ?",
      [id],
      (err, lines) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ entry, lines });
      }
    );
  });
});

// ✅ Create a new journal entry with lines
router.post("/journal_entry", (req, res) => {
  const {
    reference_number,
    date,
    description,
    adjustment_type,
    status,
    journal_lines,
  } = req.body;

  // Validate that debits equal credits
  const totalDebit = journal_lines.reduce(
    (sum, line) => sum + parseFloat(line.debit || 0),
    0
  );
  const totalCredit = journal_lines.reduce(
    (sum, line) => sum + parseFloat(line.credit || 0),
    0
  );
  if (totalDebit.toFixed(2) !== totalCredit.toFixed(2))
    return res
      .status(400)
      .json({ error: "Total debits must equal total credits" });

  // Insert journal entry
  const sql = `INSERT INTO journal_entries (reference_number, date, description, adjustment_type, status) VALUES (?, ?, ?, ?, ?)`;
  const values = [reference_number, date, description, adjustment_type, status];

  db.run(sql, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });

    const journalEntryId = this.lastID; // Get the inserted journal entry ID
    const placeholders = journal_lines.map(() => "(?, ?, ?, ?)").join(",");
    const lineValues = journal_lines.flatMap((line) => [
      journalEntryId,
      line.account_id,
      line.debit,
      line.credit,
    ]);

    // Insert journal entry lines
    db.run(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES ${placeholders}`,
      lineValues,
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
          message: "Journal entry created successfully",
          journal_entry_id: journalEntryId,
        });
      }
    );
  });
});

// ✅ Update a journal entry
router.put("/journal_entry/:id", (req, res) => {
const { id } = req.params;
const {
  reference_number,
  date,
  description,
  adjustment_type,
  status,
  journal_lines,
} = req.body;

// Validate that debits equal credits
const totalDebit = journal_lines.reduce(
  (sum, line) => sum + parseFloat(line.debit || 0),
  0
);
const totalCredit = journal_lines.reduce(
  (sum, line) => sum + parseFloat(line.credit || 0),
  0
);
if (totalDebit.toFixed(2) !== totalCredit.toFixed(2))
  return res
    .status(400)
    .json({ error: "Total debits must equal total credits" });

// Update journal entry
const sql = `UPDATE journal_entries SET reference_number = ?, date = ?, description = ?, adjustment_type = ?, status = ? WHERE id = ?`;
const values = [
  reference_number,
  date,
  description,
  adjustment_type,
  status,
  id,
];

db.run(sql, values, function (err) {
  if (err) return res.status(500).json({ error: err.message });

    // Delete existing journal entry lines
    db.run(
      "DELETE FROM journal_entry_lines WHERE journal_entry_id = ?",
      [id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        // Insert new journal entry lines
        const placeholders = journal_lines.map(() => "(?, ?, ?, ?)").join(",");
        const lineValues = journal_lines.flatMap((line) => [
          id,
          line.account_id,
          line.debit,
          line.credit,
        ]);

        db.run(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES ${placeholders}`,
          lineValues,
          function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Journal entry updated successfully" });
          }
        );
      }
    );
  });
});

// ✅ Delete a journal entry
router.delete("/journal_entry/:id", authenticateUser, (req, res) => {
  const { id } = req.params;

  // Delete journal entry
  db.run("DELETE FROM journal_entries WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    // Delete journal entry lines
    db.run(
      "DELETE FROM journal_entry_lines WHERE journal_entry_id = ?",
      [id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Journal entry deleted successfully" });
      }
    );
  });
});

router.post("/close_accounts", async (req, res) => {
  try {
    const closingDate = req.body.date; // Closing date (e.g., "2024-12-31")
    const forceOverwrite = req.body.forceOverwrite || false; // Optional parameter to force overwrite

    // Validate the closing date
    if (!closingDate || !closingDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return res
        .status(400)
        .json({ error: "Invalid closing date format. Use YYYY-MM-DD." });
    }

    // Generate reference number
    const reference_number = `CLOSE-${closingDate.replace(/-/g, "")}`;

    // Check if a closing entry already exists for this date
    const existingEntry = await new Promise((resolve, reject) => {
      db.get(
        "SELECT id FROM journal_entries WHERE reference_number = ? AND adjustment_type = 'CLOSING ENTRY'",
        [reference_number],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    // If entry exists and we're not forcing overwrite, return error
    if (existingEntry && !forceOverwrite) {
      return res.status(400).json({
        error: "Closing entry already exists",
        details: `A closing entry with reference ${reference_number} already exists. Set 'forceOverwrite: true' to replace it.`,
      });
    }

    // If entry exists and we're forcing overwrite, delete it first
    if (existingEntry && forceOverwrite) {
      // Delete the existing journal entry lines
      await new Promise((resolve, reject) => {
        db.run(
          "DELETE FROM journal_entry_lines WHERE journal_entry_id = ?",
          [existingEntry.id],
          (err) => (err ? reject(err) : resolve())
        );
      });

      // Delete the existing journal entry
      await new Promise((resolve, reject) => {
        db.run(
          "DELETE FROM journal_entries WHERE id = ?",
          [existingEntry.id],
          (err) => (err ? reject(err) : resolve())
        );
      });
    }

    // 1️⃣ Fetch Revenue and Expense Accounts
    const revenueAccounts = await new Promise((resolve, reject) => {
      db.all(
        "SELECT account_id, SUM(credit) - SUM(debit) AS balance FROM journal_entry_lines " +
          "JOIN chart_of_accounts ON journal_entry_lines.account_id = chart_of_accounts.id " +
          "WHERE chart_of_accounts.account_type = 'revenue' GROUP BY account_id",
        [],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const expenseAccounts = await new Promise((resolve, reject) => {
      db.all(
        "SELECT account_id, SUM(debit) - SUM(credit) AS balance FROM journal_entry_lines " +
          "JOIN chart_of_accounts ON journal_entry_lines.account_id = chart_of_accounts.id " +
          "WHERE chart_of_accounts.account_type = 'expense' GROUP BY account_id",
        [],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    // Filter accounts with non-zero balances
    const revenueAccountsToClose = revenueAccounts.filter(
      (acc) => acc.balance > 0
    );
    const expenseAccountsToClose = expenseAccounts.filter(
      (acc) => acc.balance > 0
    );

    // 2️⃣ Get Retained Earnings Account
    const retainedEarnings = await new Promise((resolve, reject) => {
      db.get(
        "SELECT id FROM chart_of_accounts WHERE account_type = 'equity' AND account_code = '3003'",
        [],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!retainedEarnings) {
      return res.status(400).json({
        error: "Retained Earnings account not found",
        details:
          "Please create an equity account with code 3003 for Retained Earnings",
      });
    }

    // 3️⃣ Calculate Net Profit/Loss
    const totalRevenue = revenueAccountsToClose.reduce(
      (sum, acc) => sum + acc.balance,
      0
    );
    const totalExpense = expenseAccountsToClose.reduce(
      (sum, acc) => sum + acc.balance,
      0
    );
    const netIncome = totalRevenue - totalExpense;

    if (totalRevenue === 0 && totalExpense === 0) {
      return res.status(400).json({
        message: "No revenue or expense accounts to close.",
        details: "All revenue and expense accounts have zero balances.",
      });
    }

    // 4️⃣ Create Closing Journal Entry
    const closingEntryId = await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO journal_entries (reference_number, date, description, adjustment_type, status) VALUES (?, ?, ?, ?, ?)",
        [
          reference_number,
          closingDate,
          "Closing accounts for the period",
          "CLOSING ENTRY",
          "posted",
        ],
        function (err) {
          if (err) reject(err);
          resolve(this.lastID);
        }
      );
    });

    // 5️⃣ Process entries individually to avoid placeholder limit issues
    const insertJournalLine = async (entryId, accountId, debit, credit) => {
      return new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)",
          [entryId, accountId, debit, credit],
          (err) => (err ? reject(err) : resolve())
        );
      });
    };

    // 6️⃣ Close revenue accounts (debit revenue to zero them out)
    for (const account of revenueAccountsToClose) {
      await insertJournalLine(
        closingEntryId,
        account.account_id,
        account.balance,
        0
      );
    }

    // 7️⃣ Close expense accounts (credit expense to zero them out)
    for (const account of expenseAccountsToClose) {
      await insertJournalLine(
        closingEntryId,
        account.account_id,
        0,
        account.balance
      );
    }

    // 8️⃣ Balance entry with retained earnings
    if (netIncome > 0) {
      // If profit, credit retained earnings (increase equity)
      await insertJournalLine(
        closingEntryId,
        retainedEarnings.id,
        0,
        netIncome
      );
    } else if (netIncome < 0) {
      // If loss, debit retained earnings (decrease equity)
      await insertJournalLine(
        closingEntryId,
        retainedEarnings.id,
        Math.abs(netIncome),
        0
      );
    }

    // 9️⃣ Log Audit Trail if user info is available
    if (req.user && req.user.id) {
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO audit_trails (user_id, action, description, timestamp) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
          [
            req.user.id,
            "Closed Accounts",
            `Closed accounts for period ending ${closingDate}`,
          ],
          (err) => (err ? reject(err) : resolve())
        );
      });
    }

    res.json({
      message: "Accounts closed successfully",
      details: {
        totalRevenue,
        totalExpense,
        netIncome,
        numberOfAccounts:
          revenueAccountsToClose.length + expenseAccountsToClose.length,
        closingDate,
        reference: reference_number,
      },
    });
  } catch (error) {
    console.error("Error closing accounts:", error);
    res.status(500).json({ error: error.message });
  }
});

process.on("SIGINT", () => {
  db.close((err) => {
    if (err) {
      console.error("Error closing the database:", err.message);
    } else {
      console.log("Database connection closed.");
    }
    process.exit(0);
  });
});
module.exports = router;
