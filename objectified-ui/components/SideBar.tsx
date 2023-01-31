import * as React from "react";
import Box from "@mui/material/Box";
import { styled, ThemeProvider, createTheme } from "@mui/material/styles";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import ArrowRight from "@mui/icons-material/ArrowRight";
import KeyboardArrowDown from "@mui/icons-material/KeyboardArrowDown";
import Home from "@mui/icons-material/Home";
import Settings from "@mui/icons-material/Settings";
import Public from "@mui/icons-material/Public";
import {
  ClassOutlined,
  FormatListBulletedOutlined,
  GroupsOutlined,
  PersonOutlined,
  ReorderOutlined,
  RuleOutlined,
  TypeSpecimenOutlined,
  ViewListOutlined,
} from "@mui/icons-material";
import SideBarMenuItem from "./SideBarMenuItem";
import SideBarMenuGroup, { SideBarMenuGroupProps } from "./SideBarMenuGroup";

const FireNav = styled(List)<{ component?: React.ElementType }>({
  "& .MuiListItemButton-root": {
    paddingLeft: 24,
    paddingRight: 24,
  },
  "& .MuiListItemIcon-root": {
    minWidth: 0,
    marginRight: 16,
  },
  "& .MuiSvgIcon-root": {
    fontSize: 20,
  },
});

export interface SideBarProps {
  width: number;
  sidebarItems: SideBarMenuGroupProps[],
}

export default function SideBar(props: SideBarProps) {
  return (
    <Box sx={{ display: "flex" }} position={"fixed"} top={0} height={"100%"}>
      <ThemeProvider
        theme={createTheme({
          components: {
            MuiListItemButton: {
              defaultProps: {
                disableTouchRipple: true,
              },
            },
          },
          palette: {
            mode: "dark",
            primary: { main: "rgb(102, 157, 246)" },
            background: { paper: "rgb(5, 30, 52)" },
          },
        })}
      >
        <Paper elevation={0} sx={{ maxWidth: props.width }}>
          <FireNav component="nav" disablePadding>
            <ListItemButton component="a" href="#customized-list">
              <ListItemText
                sx={{ my: 0, width: props.width - 40 }}
                primary="Objectified Console"
                primaryTypographyProps={{
                  fontSize: 20,
                  fontWeight: "bold",
                  letterSpacing: 0,
                }}
              />
            </ListItemButton>
            <Divider />
            {props.sidebarItems.map((x) => <SideBarMenuGroup label={x.label} items={x.items} />)}
          </FireNav>
        </Paper>
      </ThemeProvider>
    </Box>
  );
}
