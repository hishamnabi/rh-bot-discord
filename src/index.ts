import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN!;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const GUILD_ID = process.env.GUILD_ID!;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID!;

const VERIFIED_ROLE_ID = (process.env.VERIFIED_ROLE_ID || "").trim();
const VERIFIED_ROLE_NAME = (process.env.VERIFIED_ROLE_NAME || "Verified Player").trim();

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !VERIFY_CHANNEL_ID) {
  throw new Error("Missing required env vars. Check DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, VERIFY_CHANNEL_ID.");
}

// Custom IDs
const BTN_VERIFY = "verify:btn";
const MODAL_VERIFY = "verify:modal";
const FIELD_NAME = "verify:name";
const FIELD_CITY = "verify:city";
const FIELD_POSITION = "verify:position";

// Basic normalization
function normalizeSpaces(s: string) {
  return s.trim().replace(/\s+/g, " ");
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
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
  await registerCommands();
});

// ---- Interactions ----
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // /setupverify (posts + pins a message with the Verify button)
    if (interaction.isChatInputCommand() && interaction.commandName === "setupverify") {
      if (!interaction.inGuild()) return;

      const guild = interaction.guild!;
      if (guild.id !== GUILD_ID) {
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

      const name = normalizeSpaces(interaction.fields.getTextInputValue(FIELD_NAME));
      const city = normalizeSpaces(interaction.fields.getTextInputValue(FIELD_CITY));
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

      // Assign role
      await member.roles.add(role, "Verified Player");

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
