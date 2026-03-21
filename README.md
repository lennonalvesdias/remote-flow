# 🌊 RemoteFlow

<p align="center">
  <img src="public/images/header.png" alt="RemoteFlow Header" width="100%">
</p>

> **O fluxo de desenvolvimento que acompanha você.**

[![RemoteFlow Version](https://img.shields.io/badge/version-1.0.0-2ecc71?style=for-the-badge)](https://github.com/lennondias/remoteflow)
[![Discord Bridge](https://img.shields.io/badge/Discord-Bridge-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com)
[![Powered by OpenCode](https://img.shields.io/badge/Powered%20by-OpenCode-black?style=for-the-badge)](https://github.com/opencode)

O **RemoteFlow** é a ponte definitiva entre o seu ambiente de desenvolvimento local e a ubiquidade do Discord. Ele permite interagir com agentes de IA (via OpenCode CLI) diretamente do seu telemóvel ou tablet, como se estivesse sentado à frente do seu computador.

---

## 🚀 A Ideia: Liberte o seu Código

Já sentiu que as suas melhores ideias surgem quando está longe da secretária? O **RemoteFlow** resolve o problema de estar "preso ao físico", transformando a sua máquina de desenvolvimento numa **estação de controlo remoto acessível de qualquer lugar**.

### 🔗 Como funciona o fluxo:
1. **Input:** Envia um comando `/plan` ou `/build` através de uma thread no Discord.
2. **Bridge:** O bot **RemoteFlow** capta a mensagem e comunica via WebSockets com a sua máquina local.
3. **Execução:** O **OpenCode CLI** processa a tarefa, analisa o código e executa os builds.
4. **Feedback:** O resultado volta em tempo real para o seu telemóvel através do chat.

---

## 🛠️ Stack Técnica
- **Runtime:** Node.js 🟢
- **Interface:** Discord API (Discord.js) 👾
- **Core Engine:** OpenCode CLI 🤖
- **Comunicação:** WebSockets para baixa latência e segurança ⚡

---

## 📦 Instalação Rápida

1. **Clone o repositório:**
  ```bash
  git clone https://github.com/lennondias/remoteflow.git
  cd remoteflow
  ```

2. **Instale as dependências:**
  ```bash
  npm install
  ```

3. **Configure o seu .env:**
  Crie um ficheiro `.env` com as suas credenciais (veja `.env.example`).

4. **Inicie o Flow:**
  ```bash
  npm start
  ```

---

## 🧠 Comandos Principais

| Comando | Descrição |
|---|---|
| `/plan` | Solicita à IA um plano detalhado de implementação para uma nova funcionalidade. |
| `/build` | Executa a construção, refatoração ou correção de código na máquina local. |
| `/status` | Verifica a saúde da ligação e a disponibilidade do seu host local. |

---

## 🚧 Roadmap

- [ ] Suporte para múltiplos agentes em simultâneo.
- [ ] Interface visual para monitorização de logs remotos em tempo real.
- [ ] Integração nativa com GitHub PRs através de threads de discussão.

---

## 🤝 Contribuições

O RemoteFlow é um projeto de código aberto. Sinta-se à vontade para abrir Issues ou enviar Pull Requests.

Consulte o nosso `CONTRIBUTING.md` para mais detalhes.

---

Desenvolvido para quem não quer que a criatividade fique presa a uma cadeira.