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

## Contests privados (com senha)

Como o VJudge funciona (verificado em nov/2026 com o contest 870484):

1. Para informar a senha de um contest privado, o VJudge exige **uma conta logada**. Sem
   conta, `POST /contest/login/{id}` responde `contest.error.login_required`.
2. O login de conta exige verificação humana (Cloudflare Turnstile). O gateway **não** faz
   login de conta nem tenta contornar essa verificação.
3. Sem acesso, a página do contest omite as questões e o ranking volta **vazio**
   (`participants: {}`), então não dá para saber se houve submissões.

Por isso o gateway precisa de **dois segredos**: a sessão de uma conta logada e a senha do
contest. Com eles, entra no contest sozinho (o mesmo `POST /contest/login/{id}` com o campo
`accessCode` que o botão do site usa) e só então lê questões e ranking.

| Segredo | O que é | Obrigatório para contest privado |
|---|---|---|
| `VJUDGE_COOKIE` | Cabeçalho `Cookie` de uma sessão logada no VJudge | sim |
| `VJUDGE_CONTEST_PASSWORD` | Senha do contest (também aceitos: `VJUDGE_ACCESS_CODE`, `CONTEST_PASSWORD`, `VJUDGE_PASSWORD`, `VJUDGE_SENHA`, `SENHA`, `PASSWORD`) | sim |
| `ALLOWED_ORIGINS` (variável) | Origem do app, ex.: `https://<usuario>.github.io` | sim — a sessão **nunca** é usada para origens liberadas só por `*` |

### Passo a passo

1. **Conta do evento.** Use uma conta do VJudge dedicada à organização (não pessoal).
2. **Sessão.** Abra uma janela anônima, faça login em <https://vjudge.net>, abra
   <https://vjudge.net/contest/870484> e pressione F12 → aba **Rede (Network)** → recarregue →
   clique na primeira requisição para `vjudge.net` → **Cabeçalhos da solicitação** → copie o
   valor inteiro de **Cookie**. Feche a janela **sem** clicar em "Sair" (sair invalida a sessão).
3. **Cloudflare** → Worker `wcc-gateway` → **Settings → Variables and Secrets**:
   - **Add → Secret** `VJUDGE_COOKIE` = valor copiado.
   - Confirme que a senha do contest já existe como **Secret** (qualquer um dos nomes da tabela).
   - **Add → Text** `ALLOWED_ORIGINS` = `https://<usuario>.github.io` (sem barra final; separe
     outras origens por vírgula, ex.: `,http://localhost:5173` para desenvolvimento).
4. **Publique o código 2.1** (seção "Publicar"): o código anterior (2.0) não lê a senha.
5. **Valide**: no app publicado, tela VJudge → **Testar conexão**. O diagnóstico mostra
   *"privado · acesso autorizado"*, a quantidade de questões e de contas no ranking. Também é
   possível abrir `https://<seu-worker>/vjudge/diag/870484` — a resposta indica quais
   configurações existem (nunca os valores) e o motivo de qualquer recusa do VJudge.

Cuidados: o cookie dá acesso à conta — nunca o coloque no repositório nem no app, e remova
os segredos após a competição. Sessões expiram; se o diagnóstico voltar a mostrar
`login_required`, repita o passo 2. O cabeçalho `Origin` pode ser forjado fora do navegador,
por isso use uma conta sem outros privilégios.

## Segurança

- Senha e cookie ficam **apenas** como segredos do Cloudflare. O app nunca os recebe, e o
  endpoint de diagnóstico informa só se existem.
- O gateway não registra (log) segredos, cookies ou respostas.
- `ALLOWED_ORIGINS`: padrão `*`, adequado para dados públicos (LCC, contests públicos).

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
