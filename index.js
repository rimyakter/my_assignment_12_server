// server.js

const express = require("express");
const dotenv = require("dotenv");
dotenv.config();
const cors = require("cors");
const jwt = require("jsonwebtoken");
const app = express();
const admin = require("firebase-admin");
const decode = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decode);
// const serviceAccount = require("./firebaseServiceKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const PORT = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// Middleware
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
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

//jwt Middleware
const verifyJWT = async (req, res, next) => {
  console.log("headers in middleware", req.headers);
  const token = req?.headers?.authorization?.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .send({ message: "Token missing! UnAuthorizes Access" });
  }
  // verify token using firebase admin sdk
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);

    next();
  } catch (err) {
    return res
      .status(401)
      .send({ message: "Token missing! UnAuthorizes Access" });
  }
};

async function run() {
  try {
    await client.connect();
    const db = client.db("BloodDonation");
    const donationRequestsCollection = db.collection("donationRequests");
    const usersCollection = db.collection("users");
    const blogsCollection = db.collection("blogs");

    //jwt generate
    app.post("/jwt", (req, res) => {
      const user = { email: req.body.email };
      console.log(user);

      // //token creation
      const token = jwt.sign(user, process.env.JWT_SECRET_KEY, {
        expiresIn: "7d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: false,
        })
        .send({ message: "Jwt created successfully" });
    });

    //verify role[Donor,Admin,volunteer]

    const roleBaseAccess = (...roles) => {
      console.log("roles", roles);
      return async (req, res, next) => {
        const email = req.tokenEmail;
        const query = { email };
        const user = await usersCollection.findOne(query);
        if (!user || !roles.includes(user.role)) {
          return res.status(403).send({ message: "forbidden access" });
        }
        next();
      };
    };
    // ----------- Routes -----------

    // Test route
    app.get("/", (req, res) => {
      res.send("Blood Bank API is running");
    });

    // ✅ Get all requests (admin + volunteer can see all, donor sees their own)

    app.get(
      "/donationRequests",
      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
        try {
          const { email, role } = req.tokenEmail; // from JWT
          const { requesterEmail } = req.query;

          let query = {};

          // If donor, only fetch their own requests
          if (role === "donor") {
            query.requesterEmail = email; // ignore query param for security
          } else if (requesterEmail) {
            // admin or volunteer can optionally filter by donor
            query.requesterEmail = requesterEmail;
          }

          const requests = await donationRequestsCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();

          res.status(200).json(requests);
        } catch (error) {
          console.error(error);
          res.status(500).json({ error: "Failed to fetch donation requests" });
        }
      }
    );

    // GET all pending donation requests
    app.get(
      "/donationRequests/pending",
      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
        try {
          const requests = await donationRequestsCollection
            .find({ status: "pending" }) // only pending
            .sort({ createdAt: -1 })
            .toArray();
          res.status(200).json(requests);
        } catch (err) {
          res
            .status(500)
            .json({ error: "Failed to fetch pending donation requests" });
        }
      }
    );

    // Get a pending donation request by ID | Details request page
    app.get(
      "/donationRequests/pending/:id",
      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { ObjectId } = require("mongodb");

          const donationRequest = await db
            .collection("donationRequests")
            .findOne({
              _id: new ObjectId(id),
              status: "pending", // 👈 only fetch if it's still pending
            });

          if (!donationRequest) {
            return res
              .status(404)
              .json({ error: "Pending donation request not found" });
          }

          res.status(200).json(donationRequest);
        } catch (err) {
          console.error("Error fetching pending donation request:", err);
          res
            .status(500)
            .json({ error: "Failed to fetch pending donation request" });
        }
      }
    );

    // Confirm donation: pending -> inprogress

    app.post(
      "/donationRequests/:id/confirm",

      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid request ID" });
          }

          // 1️⃣ Find the logged-in user from MongoDB
          const donor = await usersCollection.findOne({
            email: req.tokenEmail,
          });
          if (!donor) {
            return res
              .status(404)
              .json({ error: "Donor not found in database" });
          }

          // 2️⃣ Only update if request is still pending
          const filter = { _id: new ObjectId(id), status: "pending" };

          const update = {
            $set: {
              status: "inprogress",
              donorName: donor.name, // take name from users collection
              donorEmail: donor.email,
              assignedAt: new Date(),
            },
          };

          const result = await donationRequestsCollection.updateOne(
            filter,
            update
          );

          if (result.modifiedCount === 0) {
            return res.status(404).json({
              error: "Pending donation request not found or already confirmed",
            });
          }

          res.json({
            message: "Donation confirmed successfully",
            status: "inprogress",
            donorName: donor.name,
            donorEmail: donor.email,
          });
        } catch (err) {
          console.error("Error confirming donation:", err);
          res.status(500).json({ error: "Failed to confirm donation" });
        }
      }
    );

    //-------Update donation request (admin OR requester can update details)---------
    app.put(
      "/donationRequests/:id",
      verifyJWT,
      roleBaseAccess("admin", "donor"),
      async (req, res) => {
        try {
          const id = req.params.id;
          const updateData = { ...req.body };

          // Remove _id if present
          delete updateData._id;

          const request = await donationRequestsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!request) {
            return res.status(404).json({ error: "Request not found" });
          }
          // Fetch the user
          const user = await usersCollection.findOne({
            email: req.tokenEmail.toLowerCase(),
          });
          if (!user) return res.status(404).json({ error: "User not found" });

          // Only admin OR original requester can update
          if (
            user.role !== "admin" &&
            request.requesterEmail !== req.tokenEmail
          ) {
            return res
              .status(403)
              .json({ error: "Not authorized to update this request" });
          }

          const result = await donationRequestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
          );

          res.json({ message: "Request updated" });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      }
    );

    // ------------✅ Delete donation request (admin OR requester only)-----------------

    app.delete(
      "/donationRequests/:id",
      verifyJWT,
      roleBaseAccess("admin", "donor"),
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid request ID" });
          }

          const objectId = new ObjectId(id);
          const request = await donationRequestsCollection.findOne({
            _id: objectId,
          });

          if (!request) {
            return res.status(404).json({ error: "Request not found" });
          }
          // Fetch the user
          const user = await usersCollection.findOne({
            email: req.tokenEmail.toLowerCase(),
          });
          if (!user) return res.status(404).json({ error: "User not found" });

          // ✅ Only allow deletion if requester email matches token
          if (
            request.requesterEmail !== req.tokenEmail &&
            user.role !== "admin"
          ) {
            return res
              .status(403)
              .json({ error: "Not authorized to delete this request" });
          }

          await donationRequestsCollection.deleteOne({ _id: objectId });
          res.json({ message: "Request deleted" });
        } catch (err) {
          console.error("Delete route error:", err);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    //---------- allBloodDonation for admin and volunteer only-------------------

    // ✅ Get all blood donation requests (admin + volunteer can see all, donor sees their own)
    app.get(
      "/allBloodDonationRequest",
      verifyJWT,
      roleBaseAccess("admin", "volunteer", "donor"), // all roles can access
      async (req, res) => {
        try {
          const userEmail = req.tokenEmail;

          // Find the user's role from the database
          const user = await usersCollection.findOne({ email: userEmail });
          if (!user) {
            return res.status(404).json({ error: "User not found" });
          }

          let query = {};

          // If donor, only fetch their own requests
          if (user.role === "donor") {
            query.requesterEmail = userEmail;
          }

          // Fetch all matching donation requests
          const allRequests = await donationRequestsCollection
            .find(query)
            .sort({ createdAt: -1 }) // latest first
            .toArray();

          res.status(200).json(allRequests);
        } catch (err) {
          console.error("Error fetching all donation requests:", err);
          res.status(500).json({ error: "Failed to fetch donation requests" });
        }
      }
    );
    //For update all Donation page volunteer status
    app.patch(
      "/donationRequests/:id/status/admin",
      verifyJWT,
      roleBaseAccess("admin", "volunteer"),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          const result = await donationRequestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );

          if (result.modifiedCount === 0) {
            return res
              .status(404)
              .json({ error: "Request not found or status unchanged" });
          }

          res.status(200).json({ message: "Status updated successfully" });
        } catch (error) {
          console.error(error);
          res.status(500).json({ error: "Failed to update status" });
        }
      }
    );

    //------ GET a single donation request by ID------
    app.get(
      "/donationRequests/:id",
      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
        try {
          const id = req.params.id;
          const request = await donationRequestsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!request) {
            return res
              .status(404)
              .json({ error: "Donation request not found" });
          }

          res.status(200).json(request);
        } catch (error) {
          res.status(500).json({ error: "Failed to fetch donation request" });
        }
      }
    );

    // POST a new donation request
    app.post(
      "/donationRequests",
      verifyJWT,
      roleBaseAccess("donor"),
      async (req, res) => {
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
          res.status(500).json({ error: "Failed to create donation request" });
        }
      }
    );

    //-----patch for done and cancel button if status==inprogress for donor

    app.patch(
      "/donationRequests/:id/status/donor",
      verifyJWT,
      roleBaseAccess("donor"),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          if (!["done", "canceled"].includes(status)) {
            return res
              .status(400)
              .json({ error: "Invalid status. Allowed: done, canceled" });
          }

          const request = await donationRequestsCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!request)
            return res.status(404).json({ error: "Request not found" });

          if (request.status !== "inprogress") {
            return res
              .status(403)
              .json({ error: "Only in-progress requests can be updated." });
          }

          // Ensure donor can only update their own requests
          if (
            !request.requesterEmail ||
            request.requesterEmail.toLowerCase() !==
              req.tokenEmail.toLowerCase()
          ) {
            return res
              .status(403)
              .json({ error: "You are not assigned to this request." });
          }

          await donationRequestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );

          res.json({ message: `Status changed to '${status}' successfully.` });
        } catch (err) {
          console.error(err);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    // ----------------Search Donors Api-------------------------------

    app.get(
      "/users/search",
      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
        try {
          const { bloodGroup, district, upazila } = req.query;

          // Build dynamic query
          const query = { status: "active" }; // Only active donors

          if (bloodGroup) query.bloodGroup = bloodGroup;
          if (district) query.district = district;
          if (upazila)
            query.upazila = { $regex: new RegExp(`^${upazila}$`, "i") };

          const donors = await db.collection("users").find(query).toArray();

          res.status(200).json(donors);
        } catch (err) {
          console.error(err);
          res.status(500).json({ error: "Failed to fetch donors" });
        }
      }
    );

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
        res.status(500).json({ error: "Failed to register user" });
      }
    });

    // Get a user profile by email
    app.get(
      "/users/:email",
      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
        try {
          const email = decodeURIComponent(req.params.email); // decode email
          const user = await usersCollection.findOne({ email });

          if (!user) {
            return res.status(404).json({ error: "User not found" });
          }

          res.status(200).json(user);
        } catch (error) {
          res.status(500).json({ error: "Failed to fetch user" });
        }
      }
    );

    // Update a user profile by email
    app.put(
      "/users/:email",
      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
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

          res.status(200).json({ message: "Profile updated", result });
        } catch (error) {
          res.status(500).json({ error: "Failed to update user" });
        }
      }
    );

    // ---------------- All USERS API (Admin)-------------------

    // 1) Get all users (with optional ?status=active or blocked)
    app.get(
      "/users",
      verifyJWT,
      roleBaseAccess("admin", "donor", "volunteer"),
      async (req, res) => {
        try {
          const filter = {};
          if (req.query.status) {
            filter.status = req.query.status;
          }

          const users = await usersCollection.find(filter).toArray();
          res.status(200).json(users);
        } catch (error) {
          console.error("❌ Error fetching users:", error);
          res.status(500).json({ error: "Failed to fetch users" });
        }
      }
    );

    // 2) Update user status (block/unblock)
    app.patch(
      "/users/:id/status",
      verifyJWT,
      roleBaseAccess("admin", "donor", "volunteer"),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid user ID" });
          }

          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, updatedAt: new Date() } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ error: "User not found" });
          }

          // ✅ return the updated user directly
          const updatedUser = await usersCollection.findOne({
            _id: new ObjectId(id),
          });
          res.json(updatedUser);
        } catch (err) {
          console.error("❌ Error updating status:", err);
          res.status(500).json({ error: "Failed to update status" });
        }
      }
    );

    // 3) Update user role (donor → volunteer → admin)
    app.patch(
      "/users/:id/role",
      verifyJWT,
      roleBaseAccess("admin", "donor", "volunteer"),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { role } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid user ID" });
          }

          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role, updatedAt: new Date() } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ error: "User not found" });
          }

          // ✅ return the updated user directly
          const updatedUser = await usersCollection.findOne({
            _id: new ObjectId(id),
          });
          res.json(updatedUser);
        } catch (err) {
          console.error("❌ Error updating role:", err);
          res.status(500).json({ error: "Failed to update role" });
        }
      }
    );

    // 📌 Get user role by email (useUserRole Api)
    app.get(
      "/users/:email/role",
      verifyJWT,
      roleBaseAccess("admin", "donor", "volunteer"),
      async (req, res) => {
        try {
          const email = req.params.email;
          const user = await usersCollection.findOne(
            { email: email },
            { projection: { role: 1, _id: 0 } }
          );

          if (!user) {
            return res.json({ role: "user" }); // default fallback
          }

          res.json({ role: user.role || "user" });
        } catch (err) {
          console.error("Error fetching user role:", err);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    //---------Blogs API(Admin)-------------------------

    // ===================== BLOG ROUTES ===================== //

    // GET all blogs
    app.get(
      "/blogs",
      verifyJWT,
      roleBaseAccess("donor", "admin", "volunteer"),
      async (req, res) => {
        try {
          const blogs = await blogsCollection
            .find()
            .sort({ createdAt: -1 })
            .toArray();
          res.json(blogs);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      }
    );

    // POST create blog (admin + volunteer)
    app.post(
      "/blogs",
      verifyJWT,
      roleBaseAccess("admin", "volunteer"),
      async (req, res) => {
        try {
          const { title, content, thumbnail, status } = req.body;

          if (!title || !content || !thumbnail) {
            return res.status(400).json({ error: "All fields are required" });
          }

          const newBlog = {
            title,
            content,
            thumbnail,
            status: status || "draft",
            createdAt: new Date(),
          };

          const result = await blogsCollection.insertOne(newBlog);
          res
            .status(201)
            .json({ message: "Blog created", id: result.insertedId });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      }
    );

    // PATCH publish blog (admin only)
    app.patch(
      "/blogs/:id/publish",
      verifyJWT,
      roleBaseAccess("admin"),
      async (req, res) => {
        try {
          const id = req.params.id;

          const result = await blogsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "published" } }
          );

          if (result.modifiedCount === 0)
            return res.status(404).json({ error: "Blog not found" });

          res.json({ message: "Blog published successfully" });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      }
    );

    // PATCH unpublish blog (admin only)
    app.patch(
      "/blogs/:id/unpublish",
      verifyJWT,
      roleBaseAccess("admin"),
      async (req, res) => {
        try {
          const id = req.params.id;

          const result = await blogsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "draft" } }
          );

          if (result.modifiedCount === 0)
            return res.status(404).json({ error: "Blog not found" });

          res.json({ message: "Blog unpublished successfully" });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      }
    );

    // DELETE blog (admin only)
    app.delete(
      "/blogs/:id",
      verifyJWT,
      roleBaseAccess("admin"),
      async (req, res) => {
        try {
          const id = req.params.id;

          const result = await blogsCollection.deleteOne({
            _id: new ObjectId(id),
          });

          if (result.deletedCount === 0)
            return res.status(404).json({ error: "Blog not found" });

          res.json({ message: "Blog deleted successfully" });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      }
    );

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
