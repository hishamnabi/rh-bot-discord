import "dotenv/config";
import admin from "firebase-admin";
import { readFileSync } from "fs";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

// Firebase
const serviceAccount = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH!, "utf-8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TOKEN = process.env.DISCORD_TOKEN!;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const GUILD_ID = process.env.GUILD_ID!;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID!;

const VERIFIED_ROLE_ID = (process.env.VERIFIED_ROLE_ID || "").trim();
const VERIFIED_ROLE_NAME = (process.env.VERIFIED_ROLE_NAME || "Verified Player").trim();
const APPROVED_ROLE_ID = process.env.APPROVED_ROLE_ID!;

// Comma-separated list of guild IDs to register commands in. Falls back to GUILD_ID if not set.
const GUILD_IDS = (process.env.GUILD_IDS || GUILD_ID).split(",").map((id) => id.trim());

// Role to assign to new members when they join
const NEW_MEMBER_ROLE_ID = "1472350187178557562";

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !VERIFY_CHANNEL_ID) {
  throw new Error("Missing required env vars. Check DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, VERIFY_CHANNEL_ID.");
}

// Custom IDs — Verify
const BTN_VERIFY = "verify:btn";
const MODAL_VERIFY = "verify:modal";
const FIELD_NAME = "verify:name";
const FIELD_CITY = "verify:city";
const FIELD_POSITION = "verify:position";

// Custom IDs — Apply
const BTN_APPLY = "apply:btn";
const MODAL_APPLY = "apply:modal";
const APPLY_NAME = "apply:name";
const APPLY_POSITION = "apply:position";
const APPLY_PHONE = "apply:phone";
const APPLY_REFERRED_BY = "apply:referred_by";
const APPLY_CITY = "apply:city";

// Basic normalization
function normalizeSpaces(s: string) {
  return s.trim().replace(/\s+/g, " ");
}

// Capitalize first letter of each word (e.g., "john smith" -> "John Smith")
function capitalizeWords(s: string) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Nickname builder + Discord limit
function buildNickname(name: string, position: string, city: string) {
  const nick = `${name} | ${position} | ${city}`;
  return nick.length <= 32 ? nick : null;
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setupverify")
      .setDescription("Post (and pin) the verification message with button in the verify channel.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder()
      .setName("assignunverified")
      .setDescription("Assign the Unverified role to all members who have no roles.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder()
      .setName("setupapply")
      .setDescription("Post the application message with Apply button in the current channel.")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  for (const guildId of GUILD_IDS) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });
    console.log(`✅ Slash commands registered for guild ${guildId}.`);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

async function assignApprovedRole(discordUserId: string) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(discordUserId);
  const role = guild.roles.cache.get(APPROVED_ROLE_ID);
  if (!role) {
    console.error(`Approved role not found: ${APPROVED_ROLE_ID}`);
    return;
  }
  await member.roles.add(role, "Approved via web app");
  console.log(`✅ Assigned approved role to ${member.user.tag}`);
}

function startApprovalListener() {
  const playersRef = db.collection("players");

  // On startup, backfill any approved players that haven't had their role assigned yet
  playersRef
    .where("status", "==", "approved")
    .where("roleAssigned", "==", false)
    .get()
    .then(async (snapshot) => {
      for (const doc of snapshot.docs) {
        const { discordUserId } = doc.data();
        try {
          await assignApprovedRole(discordUserId);
          await doc.ref.update({ roleAssigned: true });
        } catch (err) {
          console.error(`Failed to backfill role for ${discordUserId}:`, err);
        }
      }
    })
    .catch((err) => console.error("Backfill query failed:", err));

  // Watch for new approvals in real time
  playersRef.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type !== "modified") return;
      const data = change.doc.data();
      if (data.status !== "approved" || data.roleAssigned) return;

      try {
        await assignApprovedRole(data.discordUserId);
        await change.doc.ref.update({ roleAssigned: true });
      } catch (err) {
        console.error(`Failed to assign role for ${data.discordUserId}:`, err);
      }
    });
  });

  console.log("✅ Listening for player approvals.");
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
  await registerCommands();
  startApprovalListener();
});

// Assign role to new members when they join
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (!GUILD_IDS.includes(member.guild.id)) return;

    const role = member.guild.roles.cache.get(NEW_MEMBER_ROLE_ID);
    if (!role) {
      console.error(`Could not find role with ID ${NEW_MEMBER_ROLE_ID}`);
      return;
    }

    await member.roles.add(role, "Auto-assigned on join");
    console.log(`✅ Assigned role to new member: ${member.user.tag}`);
  } catch (err) {
    console.error(`Failed to assign role to ${member.user.tag}:`, err);
  }
});

// ---- Interactions ----
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // /setupverify (posts + pins a message with the Verify button)
    if (interaction.isChatInputCommand() && interaction.commandName === "setupverify") {
      if (!interaction.inGuild()) return;

      const guild = interaction.guild!;
      if (!GUILD_IDS.includes(guild.id)) {
        await interaction.reply({ content: "This command is only configured for the specified guild.", flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = await guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: "Verify channel not found or not text-based.", flags: MessageFlags.Ephemeral });
        return;
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(BTN_VERIFY).setLabel("Verify").setStyle(ButtonStyle.Primary)
      );

      const msg = await channel.send({
        content:
          "**Player Verification**",
        components: [row],
      });

      // Try pinning (requires Manage Messages)
      const me = guild.members.me;
      if (me?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        await msg.pin().catch(() => { });
      }

      await interaction.reply({ content: "✅ Verification message posted (and pinned if permitted).", flags: MessageFlags.Ephemeral });
      return;
    }

    // /assignunverified (assigns Unverified role to members with no roles)
    if (interaction.isChatInputCommand() && interaction.commandName === "assignunverified") {
      if (!interaction.inGuild()) return;

      const guild = interaction.guild!;
      if (!GUILD_IDS.includes(guild.id)) {
        await interaction.reply({ content: "This command is only configured for the specified guild.", flags: MessageFlags.Ephemeral });
        return;
      }

      const role = guild.roles.cache.get(NEW_MEMBER_ROLE_ID);
      if (!role) {
        await interaction.reply({ content: `Could not find the Unverified role (ID: ${NEW_MEMBER_ROLE_ID}).`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Fetch all members
      const members = await guild.members.fetch();
      let assignedCount = 0;

      for (const [, member] of members) {
        // Skip bots
        if (member.user.bot) continue;

        // Check if member has only @everyone role (size === 1 means only @everyone)
        if (member.roles.cache.size === 1) {
          try {
            await member.roles.add(role, "Bulk assignment via /assignunverified");
            assignedCount++;
          } catch (err) {
            console.error(`Failed to assign role to ${member.user.tag}:`, err);
          }
        }
      }

      await interaction.editReply({ content: `✅ Assigned the **${role.name}** role to ${assignedCount} member(s) who had no roles.` });
      return;
    }

    // /setupapply (posts an Apply button in the current channel)
    if (interaction.isChatInputCommand() && interaction.commandName === "setupapply") {
      if (!interaction.inGuild()) return;

      const guild = interaction.guild!;
      if (!GUILD_IDS.includes(guild.id)) {
        await interaction.reply({ content: "This command is only configured for the specified guild.", flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: "This channel is not text-based.", flags: MessageFlags.Ephemeral });
        return;
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(BTN_APPLY).setLabel("Apply").setStyle(ButtonStyle.Success)
      );

      await channel.send({
        content: "**Ramadan Hoops Player Application**\nInterested in joining? Click the button below to apply.",
        components: [row],
      });

      await interaction.reply({ content: "✅ Application message posted.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Apply button -> show application modal
    if (interaction.isButton() && interaction.customId === BTN_APPLY) {
      const modal = new ModalBuilder()
        .setCustomId(MODAL_APPLY)
        .setTitle("Ramadan Hoops Application");

      modal.addLabelComponents(
        new LabelBuilder()
          .setLabel("What is your full name?")
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(APPLY_NAME)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(64)
          ),
        new LabelBuilder()
          .setLabel("What position do you primarily play?")
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId(APPLY_POSITION)
              .setPlaceholder("Select a position")
              .addOptions(
                new StringSelectMenuOptionBuilder().setLabel("Guard (G)").setValue("G"),
                new StringSelectMenuOptionBuilder().setLabel("Forward (F)").setValue("F"),
                new StringSelectMenuOptionBuilder().setLabel("Center (C)").setValue("C"),
              )
          ),
        new LabelBuilder()
          .setLabel("What is your phone number?")
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(APPLY_PHONE)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(20)
          ),
        new LabelBuilder()
          .setLabel("Who referred you to Ramadan Hoops?")
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(APPLY_REFERRED_BY)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(64)
          ),
        new LabelBuilder()
          .setLabel("Which Ramadan Hoops run are you applying for?")
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId(APPLY_CITY)
              .setPlaceholder("Select a city")
              .addOptions(
                new StringSelectMenuOptionBuilder().setLabel("Dallas").setValue("Dallas"),
                new StringSelectMenuOptionBuilder().setLabel("Houston").setValue("Houston"),
                new StringSelectMenuOptionBuilder().setLabel("Seattle").setValue("Seattle"),
              )
          ),
      );

      await interaction.showModal(modal);
      return;
    }

    // Apply modal submit
    if (interaction.isModalSubmit() && interaction.customId === MODAL_APPLY) {
      const name = capitalizeWords(normalizeSpaces(interaction.fields.getTextInputValue(APPLY_NAME)));
      const position = (interaction.fields.getField(APPLY_POSITION) as { values: readonly string[] }).values[0];
      const phone = normalizeSpaces(interaction.fields.getTextInputValue(APPLY_PHONE));
      const referredBy = normalizeSpaces(interaction.fields.getTextInputValue(APPLY_REFERRED_BY));
      const city = (interaction.fields.getField(APPLY_CITY) as { values: readonly string[] }).values[0];

      await db.collection("players").add({
        name,
        position,
        phone,
        referredBy: referredBy || null,
        city,
        status: "review",
        roleAssigned: false,
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        discordUserId: interaction.user.id,
        discordUsername: interaction.user.username,
      });

      console.log(`[Apply] ${name} | ${position} | ${phone} | referred by: ${referredBy || "N/A"} | city: ${city}`);

      await interaction.reply({
        content: `✅ Thanks, **${name}**! Your application for the **${city}** run has been received. We'll be in touch!`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Verify button -> show modal
    if (interaction.isButton() && interaction.customId === BTN_VERIFY) {
      if (!interaction.inGuild()) return;

      // Optional: enforce that button is used in verify channel
      if (interaction.channelId !== VERIFY_CHANNEL_ID) {
        await interaction.reply({ content: "Please use the Verify button in the verification channel.", flags: MessageFlags.Ephemeral });
        return;
      }

      // Modal
      const modal = new ModalBuilder().setCustomId(MODAL_VERIFY).setTitle("Player Verification");

      // Name (Text)
      const nameInput = new TextInputBuilder()
        .setCustomId(FIELD_NAME)
        .setLabel("Full Name (First + Last)")
        .setPlaceholder("Name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32);

      // Position (Text - user types G, F, or C)
      const positionInput = new TextInputBuilder()
        .setCustomId(FIELD_POSITION)
        .setLabel("Position (G, F, or C)")
        .setPlaceholder("G")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2);

      // City (Text)
      const cityInput = new TextInputBuilder()
        .setCustomId(FIELD_CITY)
        .setLabel("City")
        .setPlaceholder("Dallas")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(16);

      // Add components to modal (each in its own ActionRow)
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(positionInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(cityInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // Modal submit -> set nickname + add role
    if (interaction.isModalSubmit() && interaction.customId === MODAL_VERIFY) {
      if (!interaction.inGuild()) return;

      const guild = interaction.guild!;
      const member = await guild.members.fetch(interaction.user.id);

      const me = guild.members.me;
      if (!me) {
        await interaction.reply({ content: "Bot member not available.", flags: MessageFlags.Ephemeral });
        return;
      }

      const name = capitalizeWords(normalizeSpaces(interaction.fields.getTextInputValue(FIELD_NAME)));
      const city = capitalizeWords(normalizeSpaces(interaction.fields.getTextInputValue(FIELD_CITY)));
      const positionRaw = normalizeSpaces(interaction.fields.getTextInputValue(FIELD_POSITION));
      const position = positionRaw.toUpperCase();

      // Validate position
      const validPositions = ["G", "F", "C"];
      if (!validPositions.includes(position)) {
        await interaction.reply({ content: "Position must be G, F, or C. Please try again.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (name.length < 3) {
        await interaction.reply({ content: "Name looks too short. Please try again.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (city.length < 2) {
        await interaction.reply({ content: "City looks too short. Please try again.", flags: MessageFlags.Ephemeral });
        return;
      }

      const nickname = buildNickname(name, position, city);
      if (!nickname) {
        await interaction.reply({
          content: "That nickname is too long (Discord max is 32 chars). Try using just your last initial (e.g., 'Ahmed K') and try again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Permission checks
      if (!me.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
        await interaction.reply({ content: "I need **Manage Nicknames** permission to do this.", flags: MessageFlags.Ephemeral });
        return;
      }

      // Check if trying to change server owner's nickname (not allowed by Discord)
      if (member.id === guild.ownerId) {
        await interaction.reply({
          content: "⚠️ Cannot change the server owner's nickname due to Discord limitations. The owner must manually set their nickname.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // Check role hierarchy (bot's highest role must be higher than member's highest role)
      if (member.roles.highest.position >= me.roles.highest.position) {
        await interaction.reply({
          content: "⚠️ I cannot change your nickname because your highest role is equal to or higher than mine. Please move my role higher in Server Settings → Roles.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // Set nickname
      await member.setNickname(nickname, "Verified Player form");

      // Find role by ID (preferred) or name
      const role =
        (VERIFIED_ROLE_ID ? guild.roles.cache.get(VERIFIED_ROLE_ID) : null) ??
        guild.roles.cache.find((r) => r.name === VERIFIED_ROLE_NAME) ??
        null;

      if (!role) {
        await interaction.reply({
          content: `Nickname set ✅ but I couldn't find the role **${VERIFIED_ROLE_NAME}** (or VERIFIED_ROLE_ID). Create it or set VERIFIED_ROLE_ID.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        await interaction.reply({
          content: `Nickname set ✅ but I need **Manage Roles** to assign **${role.name}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Assign verified role
      await member.roles.add(role, "Verified Player");

      // Remove unverified role if they have it
      const unverifiedRole = guild.roles.cache.get(NEW_MEMBER_ROLE_ID);
      if (unverifiedRole && member.roles.cache.has(NEW_MEMBER_ROLE_ID)) {
        await member.roles.remove(unverifiedRole, "Verified Player");
      }

      await interaction.reply({
        content: `✅ Verified! Your nickname is now **${nickname}** and you have the **${role.name}** role.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "Something went wrong. Please try again.", flags: MessageFlags.Ephemeral });
      } catch { }
    }
  }
});

client.login(TOKEN);
