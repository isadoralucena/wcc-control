# WCC Gateway

Intermediário serverless que permite ao WCC Control (hospedado no GitHub Pages) ler
dados de dois sites que **não enviam cabeçalhos CORS** e, portanto, não podem ser lidos
diretamente pelo navegador:

| Rota | Origem | Resposta | Cache na borda |
|---|---|---|---|
| `GET /health` | — | `{ ok, service, version }` | — |
| `GET /lcc/labs` | `https://lcc.ufcg.edu.br/` | laboratórios, planta, siglas e status de cada computador | 120 s |
| `GET /vjudge/contest/{id}` | `https://vjudge.net/contest/{id}` (campo `dataJson`) | título, horários, `access` (`public`/`authorized`/`restricted`) e questões (`null` sem acesso) | 60 s |
| `GET /vjudge/rank/{id}` | `https://vjudge.net/contest/rank/single/{id}` | JSON original do ranking | 5 s |
| `GET /vjudge/diag/{id}` | contest + ranking | diagnóstico de acesso: quais configurações existem (nunca os valores) e o que o VJudge respondeu | — |
| `GET /vjudge/auth[?force=1]` | `vjudge.net/user/login` | estado da conta do gateway (login automático) | — |
| `POST /vjudge/enter/{id}` | `vjudge.net/contest/login/{id}` | entra no contest com `{ accessCode }` informado no app | — |

Só existem essas rotas de leitura: o gateway **não** é um proxy aberto. Ele nunca devolve
os usuários logados que aparecem no site do LCC.

> Os endereços do VJudge são os que o próprio site usa; **não são uma API oficial** e podem
> mudar. A página do LCC também pode mudar de formato. Em ambos os casos o gateway responde
> com erro claro, e o app continua com os últimos dados conhecidos e com o modo "colar JSON".

## Arquivos

- `core.js` — toda a lógica (Fetch API padrão, sem dependências). Testada em `src/domain/domain.test.ts`.
- `worker.js` — ponto de entrada do Cloudflare (o runtime só aceita handlers como export).
- `dist/wcc-gateway.js` — **arquivo único** pronto para colar no painel (`npm run gateway:bundle`).
- `wrangler.toml` — configuração para publicar pela linha de comando.

## Publicar (escolha UMA das formas)

### A. Pelo painel da Cloudflare — sem instalar nada (≈ 5 min)

1. Crie uma conta gratuita em <https://dash.cloudflare.com/sign-up> (não pede cartão).
2. Menu **Workers & Pages → Create** e escolha **"Start with Hello World!"**.
   Nome: `wcc-gateway`. Clique em **Deploy** (publica o exemplo padrão).
   > **Não** use "Upload your static files": essa opção é para sites estáticos, não executa
   > código e mostra o erro *"This uploader does not yet support projects that require a build
   > process"*.
3. Clique em **Edit code**, apague todo o conteúdo de `worker.js` no editor, cole todo o
   conteúdo de `gateway/dist/wcc-gateway.js` e clique em **Deploy** (canto superior direito).
   Para **atualizar** um Worker já publicado, repita só este passo com o arquivo novo.
4. Copie a URL exibida, algo como `https://wcc-gateway.<sua-conta>.workers.dev`.
5. Abra `https://wcc-gateway.<sua-conta>.workers.dev/health` no navegador: deve aparecer `{"ok":true,...}`.

### B. Pela linha de comando

```bash
npx wrangler login          # abre o navegador para autorizar
npm run gateway:bundle
cd gateway && npx wrangler deploy
```

## Conectar ao app

Opção 1 — **para todos os navegadores de uma vez (recomendado):** no repositório do GitHub,
**Settings → Secrets and variables → Actions → Variables → New repository variable**:
nome `WCC_GATEWAY_URL`, valor = URL do Worker. O próximo deploy do GitHub Pages já sai
conectado; nenhum organizador precisa configurar nada.

Opção 2 — **só neste navegador:** tela **03 VJudge → WCC Gateway → URL do gateway**.

Depois, em **Testar conexão**, o app faz consultas reais: saúde do gateway, site do LCC,
contest e ranking. Só considere a integração pronta quando as quatro linhas ficarem verdes.

## Contests privados — conta da organização (login automático)

Desde a versão 2.2 o gateway **faz login sozinho** com uma conta do VJudge da organização,
guarda a sessão no Workers KV e a renova quando expira. Ninguém precisa copiar cookies.

Como o VJudge funciona (verificado em nov/2026):

- `openness`: 0 = público, 1 = protegido, 2 = privado. Sem acesso, a página do contest omite as
  questões e o ranking volta vazio.
- Para informar a senha de um contest, é preciso **conta logada** (`contest.error.login_required`).
- O login (`POST /user/login`) pode exigir **verificação humana (Turnstile)** conforme o risco.
  Em teste, um login sem token foi avaliado normalmente (`invalid_credentials`). O gateway nunca
  tenta contornar a verificação: se ela for exigida, registra `human_verification`, espera 15 min
  antes de tentar de novo e o app mostra o aviso.
- A conta **gerente** do contest tem acesso sem senha (`authStatus = 3`).

### Configuração única (pessoa técnica, ≈ 10 min)

1. **Conta do evento.** Crie ou use uma conta do VJudge da organização (não pessoal) e, de
   preferência, torne-a **gerente** dos contests do WCC — assim a senha do contest nem é necessária.
2. **KV.** Cloudflare → **Storage & Databases → KV → Create** → nome `wcc-gateway`.
   Depois, Worker `wcc-gateway` → **Settings → Bindings → Add → KV namespace** →
   *Variable name* `WCC_KV`, namespace `wcc-gateway`. (Sem KV funciona, mas a sessão fica só em
   memória e o login é refeito com mais frequência.)
3. **Segredos** — Worker → **Settings → Variables and Secrets → Add**, tipo **Secret**:
   - `VJUDGE_USERNAME` = usuário da conta do evento;
   - `VJUDGE_ACCOUNT_PASSWORD` = senha dessa conta.
4. **Origem do app** — mesma tela, tipo **Text**: `ALLOWED_ORIGINS` = `https://<usuario>.github.io`
   (sem barra final; outras origens separadas por vírgula). A conta **nunca** é usada para origens
   liberadas só por `*`.
5. **Remova o `VJUDGE_COOKIE`** se existir (modo legado; com usuário e senha ele é ignorado).
6. **Publique a versão 2.2** (seção "Publicar").
7. **Valide** no app: tela **03 VJudge** → cartão *"Conta … · conectada"* e **Testar conexão**.
   Direto no navegador: `https://<seu-worker>/vjudge/diag/<id-do-contest>` (sem a conta, pois o
   acesso direto não usa a sessão) e `https://<seu-worker>/health`.

### Uso em cada competição (organizador)

Informe só o **link do contest** na tela VJudge. Se a conta for gerente, pronto. Se não for, o
app mostra o campo **Senha do contest**: digite uma vez e clique em **Entrar no contest**. A
senha vai direto para o gateway, não fica no navegador e é guardada no KV (30 dias) apenas para
o gateway reentrar sozinho se a sessão for renovada. Há limite de 5 tentativas por hora por
contest, para proteger a conta.

Segredos legados ainda aceitos para a senha do contest: `VJUDGE_CONTEST_PASSWORD`,
`VJUDGE_ACCESS_CODE`, `CONTEST_PASSWORD`, `VJUDGE_PASSWORD`, `VJUDGE_SENHA`, `SENHA`, `PASSWORD`.
A senha informada no app tem prioridade.

### O que acontece quando…

| Situação | Comportamento |
|---|---|
| A sessão expira | O gateway percebe (questões somem, ranking vira HTML ou `login_required`), refaz o login e reentra no contest com a senha guardada. |
| O VJudge pede verificação humana | Nenhuma tentativa de contorno; espera de 15 min; o app mostra o aviso e o modo "Colar JSON" segue disponível. |
| Usuário/senha errados | Espera de 30 min entre tentativas (evita bloqueio da conta); o app indica para corrigir os segredos. |
| Senha do contest errada | O app mostra a mensagem do VJudge; máximo de 5 tentativas por hora. |

## Segurança

- Usuário e senha da conta ficam **apenas** como segredos do Cloudflare. O app nunca os recebe;
  `/vjudge/auth` e `/vjudge/diag` informam só estados (nunca valores).
- O KV guarda a sessão (cookie) e a senha de contests informada pelo app; ele é privado da sua
  conta Cloudflare. Nada disso aparece em respostas nem em logs.
- `ALLOWED_ORIGINS`: padrão `*`, adequado para dados públicos (LCC, contests públicos). Para usar
  a conta, liste a origem do app explicitamente.
- O cabeçalho `Origin` pode ser forjado fora do navegador: por isso use uma conta dedicada, sem
  outros privilégios, e o limite de tentativas protege contra uso abusivo da entrada em contests.

## Limites do plano gratuito

100 000 requisições por dia e 10 ms de CPU por requisição. Medido localmente: interpretar a
página do LCC custa ~0,4 ms; o ranking, ~0,01 ms. Uma competição de 5 h com 3 abas abertas
atualizando a cada 15 s gera ~3 600 requisições — e o cache de 5 s faz com que o VJudge
receba no máximo ~1 consulta a cada 5 s, independentemente de quantas abas estejam abertas.

## Testar localmente

```bash
npm run gateway:bundle
npm run gateway:dev            # http://localhost:8787/health
```
Na tela VJudge do app em desenvolvimento, use `http://localhost:8787` como URL do gateway.
