// server.js
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
// const admin = require("firebase-admin");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.bzeuzal.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("BloodDonation");
    const donationRequestsCollection = db.collection("donationRequests");
    const usersCollection = db.collection("users");

    // ----------- Routes -----------

    // Test route
    app.get("/", (req, res) => {
      res.send("Blood Bank API is running");
    });

    // // GET all donation requests
    // // optional query ?status=pending or ?requesterEmail=... etc
    app.get("/donationRequests", async (req, res) => {
      try {
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.requesterEmail)
          filter.requesterEmail = req.query.requesterEmail;
        if (req.query.donorEmail) filter.donorEmail = req.query.donorEmail;

        const requests = await donationRequestsCollection
          .find(filter)
          .toArray();
        res.status(200).json(requests);
      } catch (error) {
        console.error("Error fetching donation requests:", error);
        res.status(500).json({ error: "Failed to fetch donation requests" });
      }
    });

    // GET all pending donation requests
    app.get("/donationRequests/pending", async (req, res) => {
      try {
        const requests = await donationRequestsCollection
          .find({ status: "pending" }) // only pending
          .sort({ createdAt: -1 })
          .toArray();
        res.status(200).json(requests);
      } catch (err) {
        console.error("Error fetching pending donation requests:", err);
        res
          .status(500)
          .json({ error: "Failed to fetch pending donation requests" });
      }
    });

    // GET a single donation request by ID
    app.get("/donationRequests/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request) {
          return res.status(404).json({ error: "Donation request not found" });
        }

        res.status(200).json(request);
      } catch (error) {
        console.error("Error fetching donation request:", error);
        res.status(500).json({ error: "Failed to fetch donation request" });
      }
    });

    // POST a new donation request
    app.post("/donationRequests", async (req, res) => {
      try {
        const newRequest = req.body;

        // Basic validation
        if (
          !newRequest.requesterName ||
          !newRequest.requesterEmail ||
          !newRequest.recipientName ||
          !newRequest.bloodGroup ||
          !newRequest.recipientDistrict
        ) {
          return res.status(400).json({
            error:
              "requesterName, requesterEmail, recipientName, bloodGroup, and recipientDistrict are required",
          });
        }

        // set defaults
        newRequest.createdAt = new Date();
        newRequest.status = newRequest.status || "pending"; // default

        // optional donor fields should be null initially
        newRequest.donorName = newRequest.donorName || null;
        newRequest.donorEmail = newRequest.donorEmail || null;

        const result = await donationRequestsCollection.insertOne(newRequest);
        res.status(201).json({
          message: "Donation request created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error creating donation request:", error);
        res.status(500).json({ error: "Failed to create donation request" });
      }
    });

    // DELETE (only requester can delete)
    app.delete("/donationRequests/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const doc = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!doc) return res.status(404).json({ error: "Not found" });

        // require authenticated user
        if (!req.user || !req.user.email) {
          return res.status(401).json({ error: "Authentication required" });
        }

        if (doc.requesterEmail !== req.user.email) {
          return res.status(403).json({
            error: "Only the requester can delete this donation request",
          });
        }

        const result = await donationRequestsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount === 0)
          return res.status(500).json({ error: "Delete failed" });
        res.json({ message: "Deleted" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Delete failed" });
      }
    });

    // PATCH (partial update, used for status changes or donor assignment)
    // This route validates status transitions and authorization:
    // - To mark status -> 'done' or 'canceled': must be current 'inprogress' AND req.user.email === donorEmail
    // - For other changes (e.g. assign donor or update small fields), additional checks below
    app.patch("/donationRequests/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const update = req.body; // e.g., { status: 'done' } or { donorEmail, donorName }

        const doc = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!doc) return res.status(404).json({ error: "Not found" });

        // If trying to change status
        if (update.status) {
          const newStatus = String(update.status).toLowerCase();

          // Only allow done/canceled transitions from inprogress by assigned donor
          if (
            newStatus === "done" ||
            newStatus === "canceled" ||
            newStatus === "cancelled"
          ) {
            if (doc.status !== "inprogress") {
              return res.status(400).json({
                error:
                  "Status can be changed to done/canceled only when current status is inprogress",
              });
            }
            if (!req.user || !req.user.email) {
              return res.status(401).json({ error: "Authentication required" });
            }
            // check donor match
            if (doc.donorEmail !== req.user.email) {
              return res.status(403).json({
                error:
                  "Only assigned donor can finalize the donation (done/canceled)",
              });
            }
            // normalize canceled spelling
            update.status = newStatus === "cancelled" ? "canceled" : newStatus;
            update.completedAt = new Date();
          } else {
            // For other status updates (e.g., pending -> inprogress) we require requester or server logic
            // Here we authorize only the requester to set status to 'inprogress' (i.e., assign a donor)
            if (!req.user || !req.user.email) {
              return res.status(401).json({ error: "Authentication required" });
            }
            if (doc.requesterEmail !== req.user.email) {
              return res.status(403).json({
                error: "Only requester can change status to this value",
              });
            }
            update.status = newStatus;
          }
        }

        // If assigning donor (donorEmail/donorName) — allow donor to accept themselves by calling this route
        // If donorEmail is being set by someone else, ensure requester is performing it
        if (update.donorEmail && update.donorEmail !== doc.donorEmail) {
          // if the caller is the candidate donor (they are claiming it)
          if (req.user && req.user.email === update.donorEmail) {
            // allow the donor to claim -> set status to inprogress
            update.status = update.status || "inprogress";
            update.donorName =
              update.donorName || req.user.name || req.user.email.split("@")[0];
            update.assignedAt = new Date();
          } else {
            // otherwise only requester can assign a donor
            if (!req.user || req.user.email !== doc.requesterEmail) {
              return res
                .status(403)
                .json({ error: "Only requester can assign a donor" });
            }
            update.assignedAt = new Date();
          }
        }

        // sanitize updates: do not allow changing createdAt or requesterEmail via patch
        delete update.createdAt;
        delete update.requesterEmail;

        const result = await donationRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: update }
        );
        if (result.matchedCount === 0)
          return res.status(404).json({ error: "Not found" });

        res.json({ message: "Updated" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Update failed" });
      }
    });

    // PUT (full update) — replace the document (only requester)
    app.put("/donationRequests/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updated = req.body;

        const doc = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!doc) return res.status(404).json({ error: "Not found" });

        if (!req.user || !req.user.email) {
          return res.status(401).json({ error: "Authentication required" });
        }
        if (doc.requesterEmail !== req.user.email) {
          return res.status(403).json({
            error: "Only the requester can update this donation request",
          });
        }

        // preserve immutable fields if you want; here we ensure createdAt remains a Date
        updated.createdAt = doc.createdAt || new Date();

        const result = await donationRequestsCollection.replaceOne(
          { _id: new ObjectId(id) },
          updated
        );
        if (result.matchedCount === 0)
          return res.status(404).json({ error: "Not found" });
        res.json({ message: "Replaced" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Update failed" });
      }
    });

    // ---------------- USER PROFILE ROUTES ----------------

    // Create a new user (registration)
    app.post("/users", async (req, res) => {
      try {
        const newUser = req.body;

        if (
          !newUser.name ||
          !newUser.email ||
          !newUser.bloodGroup ||
          !newUser.district ||
          !newUser.upazila
        ) {
          return res.status(400).json({
            error:
              "Name, email, bloodGroup, district, and upazila are required",
          });
        }

        // check if user already exists
        const existing = await usersCollection.findOne({
          email: newUser.email,
        });
        if (existing) {
          return res.status(400).json({ error: "User already exists" });
        }

        newUser.createdAt = new Date();

        const result = await usersCollection.insertOne(newUser);
        res.status(201).json({
          message: "User registered successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({ error: "Failed to register user" });
      }
    });

    // Get a user profile by email
    app.get("/users/:email", async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email); // decode email
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json(user);
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).json({ error: "Failed to fetch user" });
      }
    });

    // Update a user profile by email
    app.put("/users/:email", async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email); // decode email
        const updateData = req.body;
        console.log("📩 Incoming PUT /users/:email");
        console.log("Email param:", req.params.email);
        console.log("Updating user:", email);
        console.log("Update data:", updateData);

        // Prevent changing email fields
        delete updateData._id;
        delete updateData.email;

        const result = await usersCollection.updateOne(
          { email },
          { $set: updateData }
        );

        console.log("Update result:", result);

        res.status(200).json({ message: "Profile updated", result });
      } catch (error) {
        console.error("Error updating user:", error);
        res.status(500).json({ error: "Failed to update user" });
      }
    });

    console.log("MongoDB connected, API routes ready");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run().catch(console.dir);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port:${PORT}`);
});
