import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputApplicationCommandData,
  Client,
  CommandInteraction,
  Events,
  GatewayIntentBits,
  GuildMemberRoleManager,
  User,
} from "discord.js";
import * as k8s from "@kubernetes/client-node";
import { randomBytes } from "node:crypto";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sCore = kc.makeApiClient(k8s.CoreV1Api);
const k8sNetworking = kc.makeApiClient(k8s.NetworkingV1Api);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

interface Command extends ChatInputApplicationCommandData {
  run: (interaction: CommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const createKubernetesResources = async (
  id: string,
  password: string,
  image: string
) => {
  await k8sCore.createNamespacedService({
    namespace: "tag",
    body: {
      metadata: {
        name: `tag-${id}-writable`,
        labels: {
          app: `tag-${id}-writable`,
          tag: "true",
        },
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: id,
        },
        ports: [
          {
            name: "writable",
            protocol: "TCP",
            port: 7681,
            targetPort: 7681,
          },
        ],
      },
    },
  });

  await k8sCore.createNamespacedService({
    namespace: "tag",
    body: {
      metadata: {
        name: `tag-${id}-viewable`,
        labels: {
          app: `tag-${id}-viewable`,
          tag: "true",
        },
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: id,
        },
        ports: [
          {
            name: "viewable",
            protocol: "TCP",
            port: 7682,
            targetPort: 7682,
          },
        ],
      },
    },
  });

  await k8sNetworking.createNamespacedIngress({
    namespace: "tag",
    body: {
      metadata: {
        name: id,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        },
        labels: {
          tag: "true",
        },
      },
      spec: {
        ingressClassName: "public",
        rules: [
          {
            host: "tag.osucyber.club",
            http: {
              paths: [
                {
                  path: `/${id}/view`,
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: `tag-${id}-viewable`,
                      port: {
                        name: "viewable",
                      },
                    },
                  },
                },
                {
                  path: `/${id}`,
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: `tag-${id}-writable`,
                      port: {
                        name: "writable",
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
        tls: [
          {
            hosts: ["tag.osucyber.club"],
            secretName: "tag-tls-certificate",
          },
        ],
      },
    },
  });

  await k8sCore.createNamespacedConfigMap({
    namespace: "tag",
    body: {
      metadata: {
        name: id,
        labels: {
          tag: "true",
        },
      },
      data: {
        "autotag.env": `TTYD_ID=${id}\nTTYD_PASSWORD=${password}\n`,
      },
    },
  });

  let pod = await k8sCore.createNamespacedPod({
    namespace: "tag",
    body: {
      metadata: {
        name: id,
        labels: {
          app: id,
          tag: "true",
          password,
        },
        annotations: {
          "io.kubernetes.cri-o.userns-mode": "auto:size=65536",
        },
      },
      spec: {
        runtimeClassName: "sysbox-runc",
        hostname: `tag${id}`,
        dnsPolicy: "None",
        dnsConfig: {
          nameservers: ["1.1.1.1"],
        },
        containers: [
          {
            name: "workspace",
            image: `ghcr.io/cscosu/tag-${image}:latest`,
            imagePullPolicy: "Always",
            volumeMounts: [
              {
                name: "ttyd-config",
                mountPath: "/etc/autotag.env",
                subPath: "autotag.env",
              },
            ],
            resources: {
              limits: {
                cpu: "500m",
                memory: "2048Mi",
              },
              requests: {
                cpu: "10m",
                memory: "128Mi",
              },
            },
          },
        ],
        volumes: [
          {
            name: "ttyd-config",
            configMap: {
              name: id,
            },
          },
        ],
      },
    },
  });

  do {
    pod = await k8sCore.readNamespacedPod({
      name: id,
      namespace: "tag",
    });
    sleep(1000);
  } while (pod.status?.phase !== "Running");
};

const startTagCommand: Command = {
  name: "tag",
  description: "Tag subcommands",
  dmPermission: false,
  options: [
    {
      name: "start",
      type: ApplicationCommandOptionType.Subcommand,
      description: "Start a game of tag",
      options: [
        {
          name: "player1",
          type: ApplicationCommandOptionType.User,
          description: "The first player",
          required: true,
        },
        {
          name: "player2",
          type: ApplicationCommandOptionType.User,
          description: "The second player",
          required: true,
        },
        {
          name: "image",
          type: ApplicationCommandOptionType.String,
          choices: [{ name: "Arch Linux", value: "archlinux" }],
          description: "The image to use",
          required: true,
        },
      ],
    },
    {
      name: "end",
      type: ApplicationCommandOptionType.Subcommand,
      description: "End a game of tag",
    },
  ],
  async run(interaction) {
    const roles = interaction.member?.roles as GuildMemberRoleManager;
    // only admin role can run this command
    if (!roles.cache.some((role) => role.id === "796887971512320040")) {
      await interaction.reply({
        content: "You do not have permission to run this command!",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (interaction.options.data.some((option) => option.name === "end")) {
      const pods = await k8sCore.listNamespacedPod({ namespace: "tag" });
      pods.items.forEach(async (pod) => {
        if (pod.metadata?.labels?.tag === "true") {
          await k8sCore.deleteNamespacedPod({
            name: pod.metadata.name!,
            namespace: "tag",
          });
        }
      });

      const services = await k8sCore.listNamespacedService({
        namespace: "tag",
      });
      services.items.forEach(async (service) => {
        if (service.metadata?.labels?.tag === "true") {
          await k8sCore.deleteNamespacedService({
            name: service.metadata.name!,
            namespace: "tag",
          });
        }
      });

      const ingresses = await k8sNetworking.listNamespacedIngress({
        namespace: "tag",
      });
      ingresses.items.forEach(async (ingress) => {
        if (ingress.metadata?.labels?.tag === "true") {
          await k8sNetworking.deleteNamespacedIngress({
            name: ingress.metadata.name!,
            namespace: "tag",
          });
        }
      });

      const configmaps = await k8sCore.listNamespacedConfigMap({
        namespace: "tag",
      });
      configmaps.items.forEach(async (configmap) => {
        if (configmap.metadata?.labels?.tag === "true") {
          await k8sCore.deleteNamespacedConfigMap({
            name: configmap.metadata.name!,
            namespace: "tag",
          });
        }
      });

      await interaction.editReply({
        content: "Ended all tag game sessions",
      });
    }

    if (interaction.options.data.some((option) => option.name === "start")) {
      const image = interaction.options.get("image")?.value as string;
      const password1 = randomBytes(4).toString("hex");
      const password2 = randomBytes(4).toString("hex");

      await Promise.all([
        createKubernetesResources("1", password1, image),
        createKubernetesResources("2", password2, image),
      ]);

      const connectUrl1 = `https://admin:${password1}@tag.osucyber.club/1`;
      const connectUrl2 = `https://admin:${password2}@tag.osucyber.club/2`;

      const player1 = interaction.options.getUser("player1") as User;
      const player2 = interaction.options.getUser("player2") as User;

      player1.send({
        content: `Your tag game is accessible at ${connectUrl1}\nWhen you switch, go to ${connectUrl2}`,
      });
      player2.send({
        content: `Your tag game is accessible at ${connectUrl2}\nWhen you switch, go to ${connectUrl1}`,
      });

      await interaction.editReply({
        content: `Tag game created! Spectate at https://tag.osucyber.club\n\n<@${player1.id}> ${connectUrl1}\n<@${player2.id}> ${connectUrl2}`,
        allowedMentions: { parse: [] },
      });
    }
  },
};

const commands = [startTagCommand];

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands);

  console.log(`${c.user.tag} is ready!`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = commands.find((c) => c.name === interaction.commandName);
    if (command && command.autocomplete)
      await command.autocomplete(interaction);
  }
  if (interaction.isCommand()) {
    const command = commands.find((c) => c.name === interaction.commandName);
    if (command) await command.run(interaction);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
